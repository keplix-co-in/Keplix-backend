import cron from 'node-cron';
import Razorpay from 'razorpay';
import prisma from './prisma.js';
import Logger from './logger.js';
import { resolveExpectedCharge } from './paymentCharge.js';
import { V2_AMOUNT_INCLUDE } from './servicePricing.js';
import { resolvePayoutHoldUntil } from './platformSettings.js';
import { settleV2PaymentInTx } from './pricingV2Payment.js';

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
// DEV-25: how far back confirmed+accepted (pay-after-accept) bookings are checked.
const CONFIRMED_LOOKBACK_HOURS = 48;

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

  const recentFloor = new Date(Date.now() - CONFIRMED_LOOKBACK_HOURS * 60 * 60 * 1000);

  const staleBookings = await prisma.booking.findMany({
    where: {
      // DEV-25: vendor accept sets status 'confirmed' BEFORE the customer pays,
      // so a 'pending'-only filter never saw accepted-but-unrecorded payments.
      // Include confirmed+accepted; the write below is still guarded.
      OR: [
        { status: 'pending' },
        // Bounded to 48h (review): unpaid confirmed rows (cash, abandoned)
        // can sit forever and would eat the 200-row budget every run.
        { status: 'confirmed', vendor_status: 'accepted', createdAt: { gte: recentFloor } },
        // Pricing v2: these bookings are paid at the END (after the final
        // bill), while in_progress / service_completed. Bounded by the bill's
        // issue time for the same row-budget reason as above.
        {
          status: { in: ['in_progress', 'service_completed'] },
          vendor_status: 'accepted',
          bookingQuote: { isNot: null },
          finalBills: { some: { status: 'issued', issued_at: { gte: recentFloor } } },
        },
      ],
      createdAt: { lte: cutoff },
      payment: null,
    },
    // bookingVehicle for resolveBookingAmount below (audit #148: this used to
    // recompute from Service.price directly, ignoring both segment pricing
    // and price_snapshot -- the same duplicated-pricing-logic bug
    // resolveBookingAmount's own docstring says this file was guilty of).
    // V2_AMOUNT_INCLUDE: a v2 booking is charged its open final bill.
    include: { service: true, bookingVehicle: true, ...V2_AMOUNT_INCLUDE },
    // Newest first so a backlog can never starve fresh orphaned payments.
    orderBy: { createdAt: 'desc' },
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

      // Same resolver as verify/webhook: the order's frozen on-top fee if it
      // has one, else the legacy deducted split (2026-11-06).
      const charge = await resolveExpectedCharge(booking, order.notes);
      const expectedPaise = charge ? Math.round(charge.amount * 100) : null;
      if (captured.amount !== expectedPaise) {
        Logger.error(
          `[Reconciliation] Booking ${booking.id}: captured amount ${captured.amount} does not match expected ${expectedPaise} — needs manual review`,
        );
        continue;
      }

      // WHY (2026-11-03): this was a hardcoded 0.1, so a payment recovered
      // here ignored the admin commission switch and could be split
      // differently from the same payment recorded by verify or the webhook.
      const { amount: totalAmount, platformFee, vendorAmount, feeModel, finalBillId } = charge;
      const isV2 = Boolean(finalBillId);

      // Pricing v2 escrow (review fix 2026-11-21): same hold as verify/webhook
      // and as completion; best-effort so a settings read failure cannot stop
      // an orphaned payment being recovered.
      let v2HoldUntil = null;
      if (isV2) {
        try {
          v2HoldUntil = await resolvePayoutHoldUntil(new Date());
        } catch (holdError) {
          Logger.error(`[Reconciliation] Failed to resolve payout hold for booking ${booking.id}: ${holdError.message}`);
        }
      }
      let v2Alerts = [];

      const bookingAdvanced = await prisma.$transaction(async (tx) => {
        const payment = await tx.payment.upsert({
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
            feeModel,
            vendorPayoutStatus: 'pending',
          },
        });
        // Same guard as recordSuccessfulPayment in services/paymentService.js.
        // This was an unconditional update, but the booking was read at the
        // top of the run and two Razorpay round-trips happened since: the
        // customer may have cancelled, or the pending-timeout cron
        // auto-declined it, in the gap. Writing 'confirmed' then revived a
        // cancelled booking. vendor_status:'accepted' matters too: an order
        // created before createPaymentOrder required acceptance can belong to
        // a booking the vendor never answered, and confirming that one left
        // it stuck (accept/reject and the pending-timeout job all require
        // status 'pending'). The payment row above is recorded either way,
        // because the money has moved.
        if (isV2) {
          // A v2 booking is already in_progress / service_completed and must
          // not be moved back to confirmed. Shared helper = the exact v2 write
          // verify/webhook do: settle the bill, escrow hold, confirm-window
          // restart, and a flag (not silence) if the bill was voided.
          ({ alerts: v2Alerts } = await settleV2PaymentInTx(tx, {
            bookingId: booking.id,
            finalBillId,
            orderFinalBillId: charge.orderFinalBillId ?? null,
            paymentId: payment.id,
            amount: totalAmount,
            holdUntil: v2HoldUntil,
            eventPayload: { razorpayPaymentId: captured.id, via: 'reconciliation' },
          }));
          return true;
        }
        const { count } = await tx.booking.updateMany({
          where: { id: booking.id, status: { in: ['pending', 'confirmed'] }, vendor_status: 'accepted' },
          data: { status: 'confirmed' },
        });
        return count > 0;
      });

      // Void race (review fix 2026-11-21): after commit, existing ops-alert tag.
      for (const alert of v2Alerts) {
        Logger.error(`[MANUAL ACTION] [Reconciliation] ${alert}`);
      }

      if (!bookingAdvanced) {
        // No admin notification channel; tagged log line, same convention as
        // paymentService.js. The customer has paid for a booking that is no
        // longer live, so this needs a refund by hand.
        Logger.warn(
          `[ADMIN NOTICE] [Reconciliation] Recovered payment ${captured.id} for booking ${booking.id}, but the booking is no longer an accepted, unstarted booking (cancelled/declined meanwhile, or never accepted by the vendor) -- left as is. Check whether it needs a refund.`,
        );
      }

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
