import crypto from "crypto";
import Razorpay from "razorpay";
import prisma from "../util/prisma.js";
import { resolvePlatformFeeRate } from "../util/platformSettings.js";
import { refundableBase, FEE_MODEL_ON_TOP } from "../util/feeModel.js";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Smallest refund Razorpay accepts, in rupees.
export const MIN_GATEWAY_REFUND = 1;

/**
 * Readable reason from a Razorpay SDK error. The SDK rejects with a plain
 * object ({ statusCode, error: { description } }), not an Error, so reading
 * .message alone logged "Gateway refund failed: undefined" (2026-11-03).
 */
export const gatewayErrorText = (err) => {
  const description = err?.error?.description || err?.message || 'Unknown gateway error';
  return err?.statusCode ? `${description} (HTTP ${err.statusCode})` : description;
};

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
// Exported so financeController's refunds KPI can source from this table
// with the same definition of "actually reached the gateway" used here --
// re-listing these statuses in a second file is exactly how they'd drift.
export const GATEWAY_REACHED_STATUSES = ['gateway_confirmed', 'processed', 'reconciliation_needed'];

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

// Defined in util/payoutRules.js (no imports there, so the payout worker can
// use it without creating a Razorpay client); re-exported here for callers.
import { PAYOUT_BLOCKING_STATUSES } from "../util/payoutRules.js";
export { PAYOUT_BLOCKING_STATUSES };

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Re-derives a payment's platformFee and vendorAmount from what is still kept
 * after refunds. Owner rule (2026-11-03): the vendor gets 90% of what is left,
 * e.g. ₹1000 paid, ₹200 refunded -> vendor ₹720, Keplix ₹80.
 *
 * Uses the payment's OWN rate, not today's setting: the rate is fixed when the
 * payment is recorded, and an admin changing the fee later must not reprice
 * old bookings. The rate is read as platformFee / (platformFee + vendorAmount)
 * so it survives earlier recomputes (after one, platformFee / amount is no
 * longer the rate).
 *
 * Skipped once the payout is processing, paid or settled: that money has
 * already been sent or is being sent, and rewriting the ledger would hide it.
 *
 * @param {number} paymentId
 * @param {object} [client] prisma or a transaction client
 * @returns {Promise<{platformFee:number, vendorAmount:number}|null>} null when skipped
 */
export const recomputeSplitAfterRefunds = async (paymentId, client = prisma) => {
  const payment = await client.payment.findUnique({ where: { id: Number(paymentId) } });
  if (!payment) return null;
  if (['processing', 'paid', 'settled'].includes(payment.vendorPayoutStatus)) return null;

  const amount = parseFloat(payment.amount?.toString() || '0');
  if (!(amount > 0)) return null;

  const refundsForPayment = () => client.refund.findMany({
    where: { paymentId: payment.id, status: { in: GATEWAY_REACHED_STATUSES } },
    select: { amount: true },
  });

  // Fee on top (2026-11-06): Keplix keeps its fee, so a refund only ever
  // comes out of the vendor's price. platformFee is left untouched (that also
  // keeps refundableBase stable); vendor gets price − refunded.
  if (payment.feeModel === FEE_MODEL_ON_TOP) {
    const refunded = (await refundsForPayment())
      .reduce((sum, r) => sum + Math.round(parseFloat(r.amount.toString()) * 100), 0);
    const platformFee = parseFloat(payment.platformFee?.toString() || '0');
    const vendorAmount = Math.max(0, Math.round(refundableBase(payment) * 100) - refunded) / 100;
    await client.payment.update({ where: { id: payment.id }, data: { vendorAmount } });
    return { platformFee, vendorAmount };
  }

  const fee = parseFloat(payment.platformFee?.toString() || '0');
  const vendor = parseFloat(payment.vendorAmount?.toString() || '0');
  const keptBefore = fee + vendor;
  // A 0/0 split has no rate to keep, so use today's configured rate rather
  // than 0% (which would hand the vendor the whole remaining amount).
  const rate = keptBefore > 0 ? fee / keptBefore : await resolvePlatformFeeRate();

  const refunds = await client.refund.findMany({
    where: { paymentId: payment.id, status: { in: GATEWAY_REACHED_STATUSES } },
    select: { amount: true },
  });
  const refunded = refunds.reduce((sum, r) => sum + parseFloat(r.amount.toString()), 0);
  const remaining = Math.max(0, round2(amount - refunded));

  const platformFee = round2(remaining * rate);
  const vendorAmount = round2(remaining - platformFee);
  await client.payment.update({
    where: { id: payment.id },
    data: { platformFee, vendorAmount },
  });
  return { platformFee, vendorAmount };
};

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

  // On-top payments: the fee is never refundable (owner decision 2026-11-06),
  // so the cap is amount − platformFee. Legacy payments: the full amount.
  const totalAmount = refundableBase(payment);

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

    // A payout already on its way to the vendor can't be stopped from here,
    // and refunding the customer too would pay the same money out twice
    // (2026-11-03 review). Re-read under the lock: the payout side takes this
    // same lock before flipping to 'processing', so the check can't race it.
    const locked = await tx.payment.findUnique({ where: { id: payment.id } });
    if (locked?.vendorPayoutStatus === 'processing') {
      throw new RefundError(
        "A payout to the vendor is being sent for this payment. Wait for it to finish, then refund (the vendor's share will need recovering).",
        409,
      );
    }

    const existing = await tx.refund.findUnique({ where: { idempotencyKey } });

    if (existing) {
      // An idempotency key belongs to ONE payment. A key replayed against a
      // different payment (e.g. an admin form that kept its key after the
      // Payment ID was edited) must not retry/return the other payment's row:
      // the retry path below would move this payment's money while the ledger
      // row still points at the first payment. Refuse instead of guessing.
      if (existing.paymentId !== payment.id) {
        throw new RefundError("idempotencyKey was already used for a different payment", 409);
      }

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
    // Razorpay refuses refunds under ₹1 (2026-11-03: a ₹1 payment less its
    // ₹0.02 fee came to ₹0.98 and was rejected). Say so plainly here instead
    // of reserving a row that can only fail at the gateway.
    if (requested < MIN_GATEWAY_REFUND) {
      throw new RefundError(
        `Razorpay can't refund less than ₹${MIN_GATEWAY_REFUND}. Requested ₹${requested.toFixed(2)}.`,
        400,
      );
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
    const why = gatewayErrorText(gatewayError);
    await prisma.refund.update({
      where: { id: refund.id },
      data: { status: 'gateway_failed', attempts: { increment: 1 }, lastError: why },
    });
    throw new RefundError(`Gateway refund failed: ${why}`, 502);
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
      // On-top: the vendor's price went back in full, so nothing is owed to
      // them; platformFee stays (Keplix keeps it — counted in commission KPIs).
      if (payment.feeModel === FEE_MODEL_ON_TOP) await recomputeSplitAfterRefunds(payment.id);
    } else {
      await recomputeSplitAfterRefunds(payment.id);
    }
    // WHY (2026-11-03): this used to mark every accepted refund 'processed'.
    // Razorpay usually answers 'pending' and only later says 'processed' or
    // 'failed', so admin showed refunds as done that had not reached the
    // customer, and a later refund.failed was ignored as stale. Only a
    // 'processed' answer counts as done now; otherwise the row stays
    // 'gateway_confirmed' until the webhook or util/refundReconciler.js
    // (which polls Razorpay) finishes it via applyGatewayRefundOutcome().
    if (gatewayRefund?.status === 'processed') {
      refund = await prisma.refund.update({ where: { id: refund.id }, data: { status: 'processed' } });
    }
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
 * Applies Razorpay's final word on a refund to our Refund row. Shared by the
 * refund.processed / refund.failed webhooks and the reconciler's poll, so all
 * three agree on what each outcome means.
 *
 * @param {object} refund the Refund row
 * @param {'processed'|'failed'} outcome
 * @param {object} [entity] Razorpay's refund object, kept for the audit trail
 * @returns {Promise<{changed:boolean, refund:object}>}
 */
export const applyGatewayRefundOutcome = async (refund, outcome, entity) => {
  const audit = entity ? { gatewayResponse: JSON.stringify(entity) } : {};

  if (outcome === 'processed') {
    if (refund.status === 'processed') return { changed: false, refund };
    const updated = await prisma.refund.update({
      where: { id: refund.id },
      data: { status: 'processed', ...audit },
    });
    return { changed: true, refund: updated };
  }

  if (outcome === 'failed') {
    // A refund Razorpay already said reached the customer is not undone by a
    // stale failure event; an already-failed row needs nothing.
    if (refund.status === 'processed' || refund.status === 'gateway_failed') {
      return { changed: false, refund };
    }
    const why = entity?.error_description || entity?.error?.description || 'Razorpay reported the refund failed';
    const updated = await prisma.refund.update({
      where: { id: refund.id },
      data: { status: 'gateway_failed', lastError: why, ...audit },
    });
    // The money did not move: a payment this refund had marked 'refunded'
    // goes back to 'success' so it can be refunded again, and the vendor's
    // share is restored.
    const payment = await prisma.payment.findUnique({ where: { id: refund.paymentId } });
    if (payment?.status === 'refunded') {
      await prisma.payment.update({ where: { id: payment.id }, data: { status: 'success' } });
    }
    await recomputeSplitAfterRefunds(refund.paymentId);
    return { changed: true, refund: updated };
  }

  throw new Error(`Unknown refund outcome: ${outcome}`);
};

/**
 * Records a refund that Razorpay reports but we have no row for -- one made by
 * hand in the Razorpay dashboard. WHY (2026-11-03): these were only logged, so
 * the payment still looked fully paid, the vendor could still be paid out for
 * money the customer already got back, and admin's Refunds list never showed
 * it. Now it gets a Refund row like any other.
 *
 * Idempotent: keyed on the Razorpay refund id, so a repeated webhook or a
 * webhook racing the reconciler creates one row, not two.
 *
 * @param {object} entity Razorpay refund object (id, payment_id, amount in paise, status)
 * @returns {Promise<{refund:object, payment:object, payoutAlreadySettled:boolean}|null>}
 *          null when the Razorpay payment is not one of ours
 */
export const recordDashboardRefund = async (entity) => {
  const payment = await prisma.payment.findFirst({ where: { transactionId: entity.payment_id } });
  if (!payment) return null;

  // Our own refund racing its webhook: Razorpay can send refund.processed
  // before issueRefund has saved gatewayRefundId, so the id lookup misses.
  // Razorpay echoes our idempotency key back as `receipt`. If it matches a
  // row, the refund is ours -- recording it again would count it twice and
  // under-pay the vendor. issueRefund saves the id moments later and
  // util/refundReconciler.js finishes it from Razorpay's state.
  if (entity.receipt) {
    const ours = await prisma.refund.findFirst({ where: { idempotencyKey: entity.receipt } });
    if (ours) return { ours, payment, refund: ours, payoutAlreadySettled: false };
  }

  const refund = await prisma.refund.upsert({
    where: { idempotencyKey: `dashboard:${entity.id}` },
    update: {},
    create: {
      paymentId: payment.id,
      amount: round2((Number(entity.amount) || 0) / 100),
      reason: 'Refunded directly in the Razorpay dashboard (not through Keplix admin)',
      status: entity.status === 'processed' ? 'processed' : 'gateway_confirmed',
      gatewayRefundId: entity.id,
      gatewayResponse: JSON.stringify(entity),
      idempotencyKey: `dashboard:${entity.id}`,
      attempts: 1,
    },
  });

  // refundableBase: on-top payments are fully refunded once the vendor's
  // price is back (Keplix keeps its fee); legacy = the whole amount.
  const total = refundableBase(payment);
  const reached = await prisma.refund.findMany({
    where: { paymentId: payment.id, status: { in: GATEWAY_REACHED_STATUSES } },
    select: { amount: true },
  });
  const refunded = reached.reduce((sum, r) => sum + parseFloat(r.amount.toString()), 0);
  if (total > 0 && refunded >= total - 0.01) {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'refunded' } });
    if (payment.feeModel === FEE_MODEL_ON_TOP) await recomputeSplitAfterRefunds(payment.id);
  } else {
    await recomputeSplitAfterRefunds(payment.id);
  }

  return {
    refund,
    payment,
    payoutAlreadySettled: ['paid', 'settled', 'processing'].includes(payment.vendorPayoutStatus),
  };
};

/**
 * Asks Razorpay for a refund's current state. Used by util/refundReconciler.js
 * to finish refunds whose webhook never arrived.
 *
 * @param {string} gatewayRefundId Razorpay refund id (rfnd_...)
 */
export const fetchGatewayRefund = (gatewayRefundId) => razorpay.refunds.fetch(gatewayRefundId);

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
