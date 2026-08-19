import crypto from "crypto";
import Razorpay from "razorpay";
import prisma from "../util/prisma.js";
import { resolveBookingAmount } from "../util/servicePricing.js";

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
const PLATFORM_FEE_PERCENTAGE = 0.1; // 10% fee

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

  // Same resolver as createPaymentOrder and the webhook fallback below — see
  // util/servicePricing.js. All three must agree, or a signature that is
  // valid for the order amount will fail this file's OWN captured-amount
  // check a few lines down.
  const totalAmount = resolveBookingAmount(booking);
  const platformFee = totalAmount * PLATFORM_FEE_PERCENTAGE;
  const vendorAmount = totalAmount - platformFee;

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

  const expectedPaise = Math.round(totalAmount * 100);
  if (razorpayPayment.amount !== expectedPaise) {
    throw new PaymentError("Captured amount does not match booking price", 400);
  }

  const { payment, updatedBooking } = await recordSuccessfulPayment({
    bookingId: Number(bookingId),
    amount: totalAmount,
    platformFee,
    vendorAmount,
    method: gateway || "razorpay",
    transactionId: paymentId || `TXN${Date.now()}`,
  });

  return { payment, updatedBooking, platformFee, vendorAmount };
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
const recordSuccessfulPayment = async ({ bookingId, amount, platformFee, vendorAmount, method, transactionId }) => {
  const paymentData = {
    amount,
    currency: "INR",
    status: "success",
    method,
    transactionId,
    platformFee,
    vendorAmount,
  };

  return prisma.$transaction(async (tx) => {
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

    const updatedBooking = await tx.booking.update({
      where: { id: bookingId },
      data: { status: "confirmed" },
      include: { service: true },
    });

    return { payment, updatedBooking };
  });
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
export const recordCapturedPaymentFromWebhook = async ({ orderId, paymentId, amountPaise, bookingIdHint }) => {
  const existing = await prisma.payment.findFirst({ where: { transactionId: paymentId } });
  if (existing) {
    if (existing.status !== 'success') {
      await prisma.payment.update({ where: { id: existing.id }, data: { status: 'success' } });
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

  const totalAmount = resolveBookingAmount(booking);
  const expectedPaise = Math.round(totalAmount * 100);
  if (amountPaise !== expectedPaise) {
    // Captured amount doesn't match what this booking is worth — do not
    // silently record it as a full payment. Flag for manual review rather
    // than trusting the webhook's amount blindly.
    return { created: false, unresolved: true, mismatch: true };
  }

  const platformFee = totalAmount * PLATFORM_FEE_PERCENTAGE;
  const vendorAmount = totalAmount - platformFee;

  const { payment, updatedBooking } = await recordSuccessfulPayment({
    bookingId,
    amount: totalAmount,
    platformFee,
    vendorAmount,
    method: "razorpay",
    transactionId: paymentId,
  });

  return { created: true, payment, updatedBooking };
};
