import crypto from "crypto";
import Razorpay from "razorpay";
import prisma from "../util/prisma.js";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/**
 * Thrown by service functions to carry an intended HTTP status code, so the
 * controller can map it to a response without the service layer knowing
 * anything about Express.
 */
export class RefundError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'RefundError';
    this.statusCode = statusCode;
  }
}

// States a Refund row that has already reached the gateway (successfully or
// not yet resolved) can be in — mirrors PayoutSettlement's design. Reaching
// one of these means the caller must not re-issue: the money either moved or
// its fate is unknown.
const GATEWAY_REACHED_STATUSES = ['gateway_confirmed', 'processed', 'reconciliation_needed'];

// Statuses whose amounts are RESERVED against the payment's refundable
// balance. This deliberately includes 'initiated' — a row that has been
// created but hasn't hit the gateway yet still lays claim to that money.
// Excluding it was the bug: two concurrent refunds could each create an
// 'initiated' row, neither counting the other, and both pass the
// remaining-balance check. Only 'gateway_failed' releases its reservation,
// because there the money provably did not move.
// Exported so the payout guard can ask "is any refund laying claim to this
// payment?" using exactly this definition. If the two ever disagreed, a payout
// could be released against money a refund had already reserved.
export const RESERVED_STATUSES = ['initiated', ...GATEWAY_REACHED_STATUSES];

/**
 * Issues a full or partial refund for a successful payment. Admin-only —
 * callers must be authorized before this is invoked.
 *
 * There is no product-defined cancellation/refund policy yet (which windows
 * are eligible, whether garages get to dispute one, etc.) — that's a business
 * decision, not something safe to invent here. This function deliberately
 * enforces no policy beyond "the payment is capturable and the amount is
 * available"; whatever eligibility rule the business settles on should be
 * checked by the caller (e.g. a booking-cancellation flow) before this is
 * reached, or added here as an explicit, named policy once defined.
 *
 * @param {object} params
 * @param {number} params.paymentId
 * @param {number} [params.amount] - rupees; defaults to the full remaining refundable amount
 * @param {string} [params.reason]
 * @param {string} params.idempotencyKey - caller-supplied, stable across retries of the same intent
 * @param {number} [params.initiatedBy] - User.id of the admin issuing the refund
 */
export const issueRefund = async ({ paymentId, amount, reason, idempotencyKey, initiatedBy }) => {
  if (!paymentId) throw new RefundError("paymentId is required", 400);
  if (!idempotencyKey) throw new RefundError("idempotencyKey is required", 400);

  const payment = await prisma.payment.findUnique({ where: { id: Number(paymentId) } });
  if (!payment) throw new RefundError("Payment not found", 404);
  if (payment.status !== 'success') {
    throw new RefundError(`Payment is not in a refundable state (status: ${payment.status})`, 400);
  }
  if (!payment.transactionId) {
    throw new RefundError("Payment has no gateway transaction to refund", 400);
  }

  const totalAmount = parseFloat(payment.amount.toString());

  // Reserve the amount atomically.
  //
  // Computing "how much is left to refund" and then creating the row that
  // claims it must not be separable, or two concurrent refunds for the same
  // payment — each with its own idempotencyKey, so the unique constraint
  // doesn't help — will both read the same balance, both pass the check, and
  // together refund more than was ever collected. The row lock below
  // serialises all refund reservations for a given payment; everything that
  // reads or writes the balance happens while it is held.
  const reservation = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${payment.id} FOR UPDATE`;

    const existing = await tx.refund.findUnique({ where: { idempotencyKey } });

    if (existing) {
      // Already reached the gateway — nothing more to do.
      if (GATEWAY_REACHED_STATUSES.includes(existing.status)) {
        return { refund: existing, alreadyProcessed: true };
      }

      // 'initiated' means another request reserved this exact intent and is
      // between the lock being released and the gateway call returning. The
      // unique constraint stops a second ROW being created, but it does not
      // stop a second GATEWAY CALL — duplicate requests with the same key
      // were each falling through to razorpay.payments.refund and refunding
      // the money more than once while the database still showed one refund.
      // Treat it as in-flight and return, rather than racing it.
      //
      // Only 'gateway_failed' falls through to be retried below, because there
      // the money provably did not move. A row stuck in 'initiated' because a
      // process died mid-call is deliberately NOT auto-retried: whether that
      // refund actually went through is unknown, so it needs reconciliation
      // rather than a guess that could double-refund.
      if (existing.status === 'initiated') {
        return { refund: existing, alreadyProcessed: true, inFlight: true };
      }
    }

    const priorRefunds = await tx.refund.findMany({
      where: {
        paymentId: payment.id,
        status: { in: RESERVED_STATUSES },
        idempotencyKey: { not: idempotencyKey },
      },
    });
    const alreadyRefunded = priorRefunds.reduce((sum, r) => sum + parseFloat(r.amount.toString()), 0);
    const remaining = totalAmount - alreadyRefunded;

    if (remaining <= 0) {
      throw new RefundError("Payment has already been fully refunded", 400);
    }

    const requested = amount != null ? Number(amount) : remaining;
    if (!(requested > 0) || requested > remaining + 0.005) {
      throw new RefundError(`Refund amount must be between 0 and ${remaining.toFixed(2)}`, 400);
    }

    // A previously failed attempt with this key is retried by resetting it to
    // 'initiated' rather than creating a second row (idempotencyKey is unique).
    const row = existing
      ? await tx.refund.update({
          where: { id: existing.id },
          data: { amount: requested, status: 'initiated', reason: reason || existing.reason },
        })
      : await tx.refund.create({
          data: {
            paymentId: payment.id,
            amount: requested,
            reason: reason || null,
            status: 'initiated',
            idempotencyKey,
            initiatedBy: initiatedBy ?? null,
          },
        });

    return { refund: row, refundAmount: requested, alreadyRefunded };
  });

  if (reservation.alreadyProcessed) {
    return { refund: reservation.refund, alreadyProcessed: true, inFlight: reservation.inFlight === true };
  }

  let refund = reservation.refund;
  const refundAmount = reservation.refundAmount;
  const alreadyRefunded = reservation.alreadyRefunded;

  let gatewayRefund;
  try {
    // Razorpay's refund API doesn't take a first-class idempotency header the
    // way orders/payouts do; `receipt` is our own reference for traceability
    // on their side. Idempotency is enforced application-side instead: the
    // reservation above created/claimed this Refund row under a lock before
    // we got here, and a retry with the same key short-circuits on
    // GATEWAY_REACHED_STATUSES — so this call is reached at most once per
    // distinct refund intent, and the total reserved can never exceed the
    // payment.
    gatewayRefund = await razorpay.payments.refund(payment.transactionId, {
      amount: Math.round(refundAmount * 100),
      speed: 'optimum',
      receipt: idempotencyKey,
      notes: reason ? { reason } : undefined,
    });
  } catch (gatewayError) {
    await prisma.refund.update({
      where: { id: refund.id },
      data: { status: 'gateway_failed', attempts: { increment: 1 }, lastError: gatewayError.message },
    });
    throw new RefundError(`Gateway refund failed: ${gatewayError.message}`, 502);
  }

  // The refund has happened at the gateway. Record that before anything else
  // — same reasoning as PayoutSettlement: a crash on the next line must never
  // cause a retry to call the gateway a second time.
  refund = await prisma.refund.update({
    where: { id: refund.id },
    data: {
      status: 'gateway_confirmed',
      gatewayRefundId: gatewayRefund.id,
      gatewayResponse: JSON.stringify(gatewayRefund),
      attempts: { increment: 1 },
    },
  });

  const isFullRefund = Math.abs(alreadyRefunded + refundAmount - totalAmount) < 0.01;
  const payoutAlreadySettled = ['paid', 'settled'].includes(payment.vendorPayoutStatus);

  try {
    if (isFullRefund) {
      await prisma.payment.update({ where: { id: payment.id }, data: { status: 'refunded' } });
    }
    await prisma.refund.update({ where: { id: refund.id }, data: { status: 'processed' } });
  } catch (bookkeepingError) {
    // Mirrors payoutWorker: the gateway refund already succeeded, so this is
    // a bookkeeping problem, not a refund problem — flag for a human, don't
    // pretend it can be silently retried into correctness.
    await prisma.refund.update({
      where: { id: refund.id },
      data: { status: 'reconciliation_needed', lastError: bookkeepingError.message },
    }).catch(() => {});
  }

  // A refund issued after the vendor's share was already paid out means
  // Keplix is now out that money until it's clawed back from the vendor —
  // there's no automatic mechanism for that (deducting from a future payout,
  // invoicing the vendor, etc.) because that's a business policy decision,
  // not a technical one. Surface it loudly rather than pretend it's handled.
  return { refund, alreadyProcessed: false, payoutAlreadySettled, isFullRefund };
};

/**
 * A stable idempotency key derived from the caller's intent when the client
 * doesn't supply its own (e.g. a UI that hasn't been updated to generate
 * one). NOT safe to use for automatic retries of a genuinely new refund
 * request — it collapses same-second duplicate clicks, nothing more.
 */
export const deriveIdempotencyKey = (paymentId, amount) =>
  crypto
    .createHash('sha256')
    .update(`refund:${paymentId}:${amount ?? 'full'}:${Math.floor(Date.now() / 5000)}`)
    .digest('hex');
