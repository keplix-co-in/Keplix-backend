import cron from 'node-cron';
import Razorpay from 'razorpay';
import prisma from './prisma.js';
import Logger from './logger.js';
import { resolveBookingAmount } from './servicePricing.js';

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// How long a booking sits "pending" before its (possibly nonexistent)
// payment is worth checking against Razorpay directly. This is the backstop
// for the interrupted-payment case the client-side retry logic can't fully
// cover on its own: the customer's app died or lost connectivity after
// Razorpay confirmed the charge but before /verify or the webhook ever
// reached this server. Without this job, that money is captured at Razorpay
// with no record here and no automatic way to find it again.
const STALE_THRESHOLD_MINUTES = 15;

/**
 * Finds bookings that have been sitting unpaid for longer than makes sense
 * for a normal checkout, and asks Razorpay directly whether a payment was
 * actually captured for any of them — rather than trusting that "no Payment
 * row" means "no money moved".
 *
 * This can only recover a payment if the order was created with `notes:
 * { bookingId }` (see controllers/user/paymentController.js createPaymentOrder)
 * — that's the only durable link between a Razorpay order and a booking that
 * survives the client never calling back.
 */
export const reconcileStalePayments = async () => {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000);

  const staleBookings = await prisma.booking.findMany({
    where: {
      status: 'pending',
      createdAt: { lte: cutoff },
      payment: null,
    },
    // bookingVehicle for resolveBookingAmount below (audit #148: this used to
    // recompute from Service.price directly, ignoring both segment pricing
    // and price_snapshot -- the same duplicated-pricing-logic bug
    // resolveBookingAmount's own docstring says this file was guilty of).
    include: { service: true, bookingVehicle: true },
    take: 200, // bounded per run — this is a periodic sweep, not a batch backfill
  });

  if (staleBookings.length === 0) return { checked: 0, recovered: 0 };

  Logger.info(`[Reconciliation] Checking ${staleBookings.length} stale unpaid booking(s)`);

  let recovered = 0;

  for (const booking of staleBookings) {
    try {
      // Razorpay orders can be searched by receipt, which createPaymentOrder
      // sets to `rcpt_bk_${bookingId}` — this is the lookup path when we
      // don't already have an order id stored anywhere for this booking.
      const orders = await razorpay.orders.all({ receipt: `rcpt_bk_${booking.id}`, count: 1 });
      const order = orders?.items?.[0];
      if (!order) continue;

      const payments = await razorpay.orders.fetchPayments(order.id);
      const captured = payments?.items?.find((p) => p.status === 'captured');
      if (!captured) continue;

      const totalAmount = resolveBookingAmount(booking);
      const expectedPaise = Math.round(totalAmount * 100);
      if (captured.amount !== expectedPaise) {
        Logger.error(
          `[Reconciliation] Booking ${booking.id}: captured amount ${captured.amount} does not match expected ${expectedPaise} — needs manual review`,
        );
        continue;
      }

      const platformFee = totalAmount * 0.1;
      const vendorAmount = totalAmount - platformFee;

      await prisma.$transaction(async (tx) => {
        await tx.payment.upsert({
          where: { bookingId: booking.id },
          update: {},
          create: {
            bookingId: booking.id,
            amount: totalAmount,
            currency: 'INR',
            status: 'success',
            method: 'razorpay',
            transactionId: captured.id,
            platformFee,
            vendorAmount,
            vendorPayoutStatus: 'pending',
          },
        });
        await tx.booking.update({ where: { id: booking.id }, data: { status: 'confirmed' } });
      });

      recovered += 1;
      Logger.info(`[Reconciliation] Recovered orphaned payment for booking ${booking.id} (payment ${captured.id})`);
    } catch (err) {
      Logger.error(`[Reconciliation] Failed checking booking ${booking.id}: ${err.message}`);
    }
  }

  return { checked: staleBookings.length, recovered };
};

let scheduled = false;
// Was discarded entirely (audit #181): cron.schedule's return value is the
// only handle that can stop this task, so with nothing captured here
// gracefulShutdown in server.js had no way to stop it -- the process could
// exit mid-run, or (on a platform that keeps the event loop alive for
// pending timers) never exit at all.
let reconciliationTask = null;

export const startPaymentReconciliation = () => {
  if (scheduled) return;
  scheduled = true;

  // Every 10 minutes — frequent enough to catch an orphaned payment within
  // roughly STALE_THRESHOLD_MINUTES + 10 of it happening, without hammering
  // Razorpay's API.
  reconciliationTask = cron.schedule('*/10 * * * *', async () => {
    try {
      const result = await reconcileStalePayments();
      if (result.recovered > 0) {
        Logger.info(`[Reconciliation] Run complete: checked ${result.checked}, recovered ${result.recovered}`);
      }
    } catch (err) {
      Logger.error(`[Reconciliation] Cron run failed: ${err.message}`);
    }
  });

  Logger.info('[Reconciliation] Payment reconciliation job scheduled (every 10 minutes)');
};

export const stopPaymentReconciliation = () => {
  reconciliationTask?.stop();
  scheduled = false;
};
