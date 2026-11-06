import crypto from "crypto";
import Razorpay from "razorpay";
import prisma from "../util/prisma.js";
import { resolveExpectedCharge } from "../util/paymentCharge.js";
import { executeCancellationRefund } from "./refundPolicy.js";
import { createNotification } from "../util/notificationHelper.js";
import { renderNotification, NOTIFICATION_TYPES } from "../util/notificationTemplates.js";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Gateways a *paying user* is allowed to assert on the verify endpoint. This
// deliberately contains only real online gateways.
//
// It previously also accepted 'cash'/'card'/'upi'/'netbanking' and treated them
// as "no online gateway involved, so skip the signature check and just confirm
// the caller owns the booking". Because the verify validator accepted any
// string for `gateway`, that turned a single request into a free booking:
// POST /payments/verify {bookingId, gateway:"upi"} on your own booking recorded
// a successful payment at the full service price and created a real vendor
// payable, with no money collected. Settling a genuinely-cash booking has to be
// initiated by the vendor or an admin who witnessed the cash, never asserted by
// the person who owes it.
const ONLINE_GATEWAYS = ['razorpay'];

/**
 * Order notes carry the frozen fee (2026-11-06, fee on top). The payment
 * entity's own notes are tried first; if they lack feeModel, the order is
 * fetched. A failed fetch falls back to "no notes" = legacy maths — for an
 * on-top order that yields an amount mismatch (rejected, never mis-recorded).
 */
// Review fix 2026-11-06: the ORDER's notes are authoritative. Payment-entity
// notes can be set by the client via checkout options, so trusting them first
// let a legacy (fee-deducted) in-flight order be recorded as on_top with
// platformFee 0. Payment notes are only a fallback when the order fetch fails.
const resolveOrderNotes = async (orderId, paymentNotes) => {
  if (!orderId) return paymentNotes ?? null;
  try {
    const order = await razorpay.orders.fetch(orderId);
    if (order?.notes) return order.notes;
  } catch {
    // fall through
  }
  return paymentNotes ?? null;
};

/**
 * Constant-time string comparison. Lengths are compared first because
 * timingSafeEqual throws on a length mismatch.
 */
const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

/**
 * Thrown by service functions to carry an intended HTTP status code, so the
 * controller can map it to a response without the service layer knowing
 * anything about Express.
 */
export class PaymentError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'PaymentError';
    this.statusCode = statusCode;
  }
}

/**
 * Verifies a payment and records it, deriving the authoritative amount from
 * the booking's service price rather than trusting any client-supplied
 * amount. For online gateways (razorpay/stripe/etc.) the Razorpay HMAC
 * signature is checked; for cash-like methods (cash/card/upi/netbanking,
 * i.e. no online gateway involved) the booking must belong to the
 * requesting user instead.
 *
 * @param {object} params
 * @param {number} params.bookingId
 * @param {number} params.requestingUserId - req.user.id of the authenticated caller
 * @param {string} [params.orderId] - Razorpay order id (required for online gateways)
 * @param {string} [params.paymentId] - Razorpay payment id (required for online gateways)
 * @param {string} [params.signature] - Razorpay signature (required for online gateways)
 * @param {string} [params.gateway] - Payment method; defaults to "razorpay"
 * @returns {Promise<{ payment: object, updatedBooking: object|null, platformFee: number, vendorAmount: number }>}
 * @throws {PaymentError} 400/403/404 on invalid input, unauthorized booking, or bad signature
 */
export const verifyAndRecordPayment = async ({
  bookingId,
  requestingUserId,
  orderId,
  paymentId,
  signature,
  gateway,
}) => {
  if (!bookingId) {
    throw new PaymentError("Booking ID is required", 400);
  }

  const booking = await prisma.booking.findUnique({
    where: { id: Number(bookingId) },
    include: { service: true, bookingVehicle: true },
  });

  if (!booking || !booking.service) {
    throw new PaymentError("Booking not found", 404);
  }

  // Ownership is checked on every path, not just the cash one. Previously the
  // online path checked only the signature, so any authenticated user holding a
  // valid order/payment/signature triple (e.g. from their own cheap order)
  // could confirm somebody else's booking.
  if (booking.userId !== requestingUserId) {
    throw new PaymentError("Not authorized for this booking", 403);
  }

  // Idempotent replay guard. Verify used to upsert unconditionally, and the
  // update branch reset vendorPayoutStatus to "pending" — so replaying verify
  // against an already-settled payment re-armed it for a second payout. A
  // payment that already succeeded is terminal here.
  const existing = await prisma.payment.findUnique({
    where: { bookingId: Number(bookingId) },
  });

  // A refunded payment is just as terminal. Before 2026-11-03 only "success"
  // short-circuited, so replaying /verify on a refunded payment fell through
  // to the upsert and set it back to "success" -- re-arming a payout for money
  // the customer already got back. The webhook path already refused this.
  if (existing && existing.status === "refunded") {
    return {
      payment: existing,
      updatedBooking: booking,
      platformFee: existing.platformFee ? parseFloat(existing.platformFee.toString()) : 0,
      vendorAmount: existing.vendorAmount ? parseFloat(existing.vendorAmount.toString()) : 0,
      alreadyRecorded: true,
      bookingActive: false,
      refundOutcome: { refunded: true },
    };
  }

  if (existing && existing.status === "success") {
    return {
      payment: existing,
      updatedBooking: booking,
      platformFee: existing.platformFee ? parseFloat(existing.platformFee.toString()) : 0,
      vendorAmount: existing.vendorAmount ? parseFloat(existing.vendorAmount.toString()) : 0,
      alreadyRecorded: true,
    };
  }

  if (!ONLINE_GATEWAYS.includes(String(gateway ?? 'razorpay').toLowerCase())) {
    throw new PaymentError(
      "Unsupported payment gateway. Cash settlement cannot be self-reported.",
      400,
    );
  }

  if (!orderId || !paymentId || !signature) {
    throw new PaymentError(
      "orderId, paymentId and signature are required",
      400,
    );
  }

  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(orderId + "|" + paymentId)
    .digest("hex");

  if (!safeEqual(expectedSignature, signature)) {
    throw new PaymentError("Invalid payment signature", 400);
  }

  // The signature only proves this (orderId, paymentId) pair was produced by
  // Razorpay for our key — it does NOT prove the payment was actually
  // captured, or for how much, or against this order. Ask Razorpay directly
  // rather than trusting the client's word for any of that.
  let razorpayPayment;
  try {
    razorpayPayment = await razorpay.payments.fetch(paymentId);
  } catch (err) {
    throw new PaymentError("Unable to verify payment with gateway", 502);
  }

  if (razorpayPayment.order_id !== orderId) {
    throw new PaymentError("Payment does not belong to the given order", 400);
  }

  if (razorpayPayment.status !== "captured") {
    throw new PaymentError(
      `Payment is not captured (status: ${razorpayPayment.status})`,
      400,
    );
  }

  // Expected amount + split: from the order's frozen notes for on-top orders,
  // else legacy (booking price, fee deducted at today's rate) so orders
  // created before the switch still verify. See util/paymentCharge.js.
  const charge = await resolveExpectedCharge(
    booking,
    await resolveOrderNotes(orderId, razorpayPayment.notes),
  );
  if (!charge || razorpayPayment.amount !== Math.round(charge.amount * 100)) {
    throw new PaymentError("Captured amount does not match booking price", 400);
  }
  const { amount: totalAmount, platformFee, vendorAmount, feeModel } = charge;

  const { payment, updatedBooking, bookingActive, refundOutcome } = await recordSuccessfulPayment({
    bookingId: Number(bookingId),
    amount: totalAmount,
    platformFee,
    vendorAmount,
    feeModel,
    method: gateway || "razorpay",
    transactionId: paymentId || `TXN${Date.now()}`,
  });

  // bookingActive/refundOutcome let the controller tell the customer their
  // payment arrived for a booking that had already been cancelled (and is
  // being refunded) instead of reporting a normal success.
  return { payment, updatedBooking, platformFee, vendorAmount, bookingActive, refundOutcome };
};

/**
 * Shared write path for "this payment is confirmed, persist it" — used by
 * both the client-driven verify flow above and the webhook fallback below.
 * Payment record + booking status update commit together (if the booking
 * update failed after the payment was already saved, we'd have a "paid"
 * payment left dangling with no confirmed booking), and vendorPayoutStatus
 * is set only on create — a re-run of this on an existing row must never
 * reach back in and reset a payout that has already been initiated.
 */
const recordSuccessfulPayment = async ({ bookingId, amount, platformFee, vendorAmount, feeModel = null, method, transactionId }) => {
  const paymentData = {
    feeModel,
    amount,
    currency: "INR",
    status: "success",
    method,
    transactionId,
    platformFee,
    vendorAmount,
  };

  const result = await prisma.$transaction(async (tx) => {
    // Serialise concurrent verifies for this booking on the booking row.
    // Payment.bookingId is unique, but an upsert is a read-then-write: several
    // simultaneous verifies (a double-tapped pay button, a client retry racing
    // the webhook) all found no payment, all tried to insert, and the losers
    // got a raw P2002 back as a 500. The row lock makes them queue instead, so
    // the first inserts and the rest take the update branch — the caller sees
    // a successful, idempotent result rather than a server error.
    await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${bookingId} FOR UPDATE`;

    const payment = await tx.payment.upsert({
      where: { bookingId },
      update: paymentData,
      create: {
        bookingId,
        ...paymentData,
        vendorPayoutStatus: "pending",
      },
    });

    // Guarded: a payment may only move a LIVE, vendor-accepted booking to
    // confirmed. This was an unconditional update, so a capture landing late
    // (the customer paid in a tab left open, or the webhook arrived after the
    // fact) revived a cancelled booking straight back to confirmed, and a
    // payment on an in_progress/service_completed booking rolled it BACK to
    // confirmed. Anything else keeps the status it has; the payment row is
    // still recorded above because the money has genuinely moved.
    const { count } = await tx.booking.updateMany({
      where: {
        id: bookingId,
        status: { in: ["pending", "confirmed"] },
        vendor_status: "accepted",
      },
      data: { status: "confirmed" },
    });

    const updatedBooking = await tx.booking.findUnique({
      where: { id: bookingId },
      include: { service: true },
    });

    return { payment, updatedBooking, bookingAdvanced: count > 0 };
  });

  const { payment, updatedBooking, bookingAdvanced } = result;

  if (bookingAdvanced || !updatedBooking) {
    return { payment, updatedBooking, bookingActive: Boolean(updatedBooking) };
  }

  // A captured payment for a booking that is already dead. It must not be
  // revived (above), and the customer must not be left out of pocket for a
  // service that cannot happen: refund the whole amount, fee included
  // (forceFullRefund -- see refundPolicy.js for why the normal cancellation
  // policy does not apply). Run AFTER the transaction commits, because
  // issueRefund reads the payment row this transaction just wrote.
  if (updatedBooking.status === "cancelled") {
    console.warn(
      `[ADMIN NOTICE] Payment ${payment.id} captured for booking ${bookingId}, which is already cancelled. ` +
      `Booking left cancelled; issuing a full refund.`
    );
    const refundOutcome = await executeCancellationRefund({
      booking: updatedBooking,
      payment,
      forceFullRefund: true,
      reason: `Payment received after booking #${bookingId} was cancelled -- full refund`,
    });

    if (refundOutcome.refunded) {
      // Best-effort: createNotification never throws.
      const n = renderNotification(NOTIFICATION_TYPES.PAYMENT_REFUNDED_BOOKING_INACTIVE, {
        amount: refundOutcome.amount ?? amount,
        bookingId,
      });
      await createNotification({
        userId: updatedBooking.userId,
        title: n.title,
        message: n.body,
        type: n.type,
        data: n.data,
      });
      if (refundOutcome.payoutAlreadySettled) {
        console.error(
          `[MANUAL ACTION] Booking ${bookingId} refunded after vendor payout was settled -- ` +
          `amount must be recovered from the vendor.`
        );
      }
    } else {
      console.error(
        `[MANUAL ACTION] Payment ${payment.id} on cancelled booking ${bookingId} could not be refunded ` +
        `automatically (${refundOutcome.code}: ${refundOutcome.reason}). Refund it from the admin finance page.`
      );
    }

    return { payment, updatedBooking, bookingActive: false, refundOutcome };
  }

  // Not cancelled and not advanced: either the job is already further along
  // (in_progress / service_completed / user_confirmed / disputed -- leave it
  // exactly where it is, the payment simply settles it), or the vendor has
  // not accepted yet. The second can only come from an order created before
  // createPaymentOrder started requiring acceptance; nothing reverses it
  // automatically if the vendor then declines, so say so loudly.
  if (updatedBooking.vendor_status !== "accepted") {
    console.warn(
      `[ADMIN NOTICE] Payment ${payment.id} captured for booking ${bookingId} before the vendor accepted it ` +
      `(vendor_status ${updatedBooking.vendor_status}). Status left as ${updatedBooking.status}.`
    );
  }
  return { payment, updatedBooking, bookingActive: true };
};

/**
 * Webhook fallback: creates/confirms a payment purely from a Razorpay
 * `payment.captured` event, for the case where the client died or lost
 * connectivity before ever calling /verify. The webhook is the only party
 * guaranteed to eventually hear about a captured payment in that scenario,
 * so it has to be able to do everything verify does — resolve the booking,
 * derive the authoritative amount, and record it — not just flip a
 * pre-existing row.
 *
 * @param {object} params
 * @param {string} params.orderId
 * @param {string} params.paymentId
 * @param {number} params.amountPaise - amount actually captured, from the webhook payload
 * @param {string} [params.bookingIdHint] - order notes.bookingId, if present
 */
export const recordCapturedPaymentFromWebhook = async ({ orderId, paymentId, amountPaise, bookingIdHint, notes }) => {
  const existing = await prisma.payment.findFirst({ where: { transactionId: paymentId } });
  if (existing) {
    // Promote only a row that has not settled yet. This was `!== 'success'`,
    // which also matched 'refunded': Razorpay redelivers payment.captured
    // (retries, or a manual replay from its dashboard) long after a refund,
    // and each redelivery flipped a refunded payment back to 'success' --
    // re-arming the vendor payout and auto-confirm paths for money that had
    // already gone back to the customer. Guarded in the WHERE as well, so a
    // refund committing between the read and this write still wins.
    if (existing.status === 'pending' || existing.status === 'failed') {
      await prisma.payment.updateMany({
        where: { id: existing.id, status: { in: ['pending', 'failed'] } },
        data: { status: 'success' },
      });
    }
    return { created: false };
  }

  if (!bookingIdHint) {
    // No existing row and no way to resolve a booking — nothing more this
    // handler can safely do. Left for manual reconciliation.
    return { created: false, unresolved: true };
  }

  const bookingId = Number(bookingIdHint);
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { service: true, bookingVehicle: true },
  });

  if (!booking || !booking.service) {
    return { created: false, unresolved: true };
  }

  const existingByBooking = await prisma.payment.findUnique({ where: { bookingId } });
  if (existingByBooking && existingByBooking.status === 'success') {
    return { created: false };
  }

  // Same resolver as verify (frozen notes for on-top orders, legacy otherwise).
  const charge = await resolveExpectedCharge(booking, await resolveOrderNotes(orderId, notes));
  if (!charge || amountPaise !== Math.round(charge.amount * 100)) {
    // Captured amount doesn't match what this booking is worth — do not
    // silently record it as a full payment. Flag for manual review rather
    // than trusting the webhook's amount blindly.
    return { created: false, unresolved: true, mismatch: true };
  }

  const { payment, updatedBooking, bookingActive, refundOutcome } = await recordSuccessfulPayment({
    bookingId,
    amount: charge.amount,
    platformFee: charge.platformFee,
    vendorAmount: charge.vendorAmount,
    feeModel: charge.feeModel,
    method: "razorpay",
    transactionId: paymentId,
  });

  return { created: true, payment, updatedBooking, bookingActive, refundOutcome };
};
