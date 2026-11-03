import prisma from "../util/prisma.js";
import { initiateVendorPayout, fetchVendorPayout, describePayoutFailure } from "../util/payoutHelper.js";
import { FAILED_PAYOUT_STATES, PAID_PAYOUT_STATE } from "../util/razorpayXClient.js";
import { createNotification } from "../util/notificationHelper.js";
import { renderNotification, NOTIFICATION_TYPES } from "../util/notificationTemplates.js";
import Logger from "../util/logger.js";
import { PAYOUT_READY_BOOKING_STATUSES, PAYOUT_DEAD_BOOKING_STATUSES, PAYOUT_BLOCKING_STATUSES } from "../util/payoutRules.js";

/**
 * processPayoutJob
 *
 * The actual payout logic, deliberately kept in its own module with no BullMQ
 * or Redis import so it can be driven directly by tests. workers/payoutWorker.js
 * is the thin BullMQ wiring around it.
 *
 * For each job:
 *   1. Re-fetches the payment (source of truth, not the job snapshot).
 *   2. Skips if already "paid" (idempotency if a job is retried/duplicated).
 *   3. Upserts a PayoutSettlement row keyed uniquely on paymentId, and uses
 *      ITS state — not just the gateway call's try/catch — to decide whether
 *      the gateway has already been paid.
 *   4. Calls the gateway ONLY if the settlement isn't already past that point,
 *      and records "gateway_confirmed" immediately once it succeeds, before
 *      touching anything else that could fail.
 *   5. Finishes bookkeeping (Payment.vendorPayoutStatus, notification). If
 *      THIS part fails after the gateway call already succeeded, the job is
 *      marked "reconciliation_needed" instead of "failed" and is NOT
 *      rethrown — a "failed" status here would invite a retry that calls the
 *      gateway a second time for a payout that already went through, i.e. a
 *      double payout triggered by a DB/notification error that had nothing to
 *      do with the money actually moving.
 *
 * job.data:
 *   paymentId - Payment.id to settle
 *   vendorId  - User.id of the vendor receiving the payout
 *   bookingId - Booking.id (used in the vendor notification copy)
 */
export const processPayoutJob = async (job) => {
  const { paymentId, vendorId } = job.data;

  Logger.info(`[Payout Worker] Processing payout for Payment ID: ${paymentId}`);

  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { booking: { include: { service: true } } },
  });

  if (!payment) {
    throw new Error(`Payment ${paymentId} not found`);
  }

  if (payment.vendorPayoutStatus === "paid") {
    Logger.info(`[Payout Worker] Payment ${paymentId} already paid. Skipping.`);
    return;
  }

  const vendorAmount = parseFloat(payment.vendorAmount?.toString() || "0");

  // upsert, not findUnique-then-create: with worker concurrency 5 and
  // duplicate jobs for the same payment, two workers could both find no
  // settlement row and both try to create one, and the loser would throw
  // P2002 and fail the job. The unique constraint on paymentId makes this
  // atomic; the empty update means an existing row is returned untouched
  // so an in-flight settlement's status is never clobbered back to
  // "initiated".
  const settlement = await prisma.payoutSettlement.upsert({
    where: { paymentId },
    update: {},
    create: { paymentId, amount: vendorAmount, status: "initiated" },
  });

  if (settlement.status === "settled") {
    if (payment.vendorPayoutStatus !== "paid") {
      await prisma.payment.update({
        where: { id: paymentId },
        data: { vendorPayoutStatus: "paid", vendorPayoutId: settlement.gatewayPayoutId },
      });
    }
    return;
  }

  // "gateway_confirmed" and "reconciliation_needed" both mean RazorpayX
  // already ACCEPTED a payout on a prior attempt. Creating another would be
  // a second real transfer, so instead ask RazorpayX what became of it.
  const gatewayAlreadyConfirmed =
    settlement.status === "gateway_confirmed" || settlement.status === "reconciliation_needed";

  let payoutId;
  let payoutStatus;
  if (gatewayAlreadyConfirmed) {
    if (!settlement.gatewayPayoutId) {
      Logger.error(`[Payout Worker] Settlement for Payment ${paymentId} is ${settlement.status} with no payout id. Needs manual reconciliation.`);
      return;
    }
    // Throws on a gateway/network error -> the job retries later. Never
    // falls through to creating a new payout.
    const payout = await fetchVendorPayout(settlement.gatewayPayoutId);
    payoutId = payout.id;
    payoutStatus = payout.status;
    if (FAILED_PAYOUT_STATES.includes(payoutStatus)) {
      await recordRefusedPayout(paymentId, settlement, payoutId, describePayoutFailure(payout));
      return;
    }
  } else {
    // Last check before money moves. WHY (2026-11-03 review): the job can sit
    // in the queue for a while, and a refund or cancellation that lands in
    // that gap used to be ignored -- the customer got refunded AND the vendor
    // got paid. Nothing has been sent yet on this path, so stopping is safe.
    const stopReason = await payoutStopReason(payment);
    if (stopReason) {
      Logger.warn(`[Payout Worker] Payment ${paymentId}: payout stopped before sending. ${stopReason}`);
      await prisma.payoutSettlement.update({
        where: { paymentId },
        data: { status: "gateway_failed", lastError: `Stopped before sending: ${stopReason}` },
      });
      // Back to "pending": no money moved. The admin queue hides cancelled
      // and refunded bookings, and one whose refund later fails can be paid.
      await prisma.payment.update({ where: { id: paymentId }, data: { vendorPayoutStatus: "pending" } });
      return;
    }

    // WHY the key changes only after a refusal: the idempotency key makes
    // RazorpayX return the original payout for a repeated request. That is
    // what stops a retry after a network blip paying twice -- so network and
    // HTTP errors keep the SAME key. But once RazorpayX has refused a payout,
    // the same key would hand back that refused payout forever, so a payout
    // re-triggered after a refusal gets the next key.
    const refused = refusedPayoutIds(settlement);
    const idempotencyKey = refused.length === 0
      ? `payout_payment_${paymentId}`
      : `payout_payment_${paymentId}_r${refused.length}`;

    let payoutResult;
    try {
      payoutResult = await initiateVendorPayout(payment, vendorId, { idempotencyKey });
    } catch (gatewayError) {
      await prisma.payoutSettlement.update({
        where: { paymentId },
        data: { status: "gateway_failed", attempts: { increment: 1 }, lastError: gatewayError.message },
      });
      await prisma.payment.update({ where: { id: paymentId }, data: { vendorPayoutStatus: "failed" } }).catch(() => {});
      throw gatewayError; // real gateway failure — safe to let BullMQ retry
    }

    if (!payoutResult.success && payoutResult.terminal) {
      // Refused by RazorpayX. Automatic retries would only get the same
      // answer, so stop here; an admin can re-trigger the payout (it is
      // "failed", which payoutService allows) once the cause is fixed.
      await recordRefusedPayout(paymentId, settlement, payoutResult.payoutId, payoutResult.error, { countAttempt: true });
      return;
    }

    if (!payoutResult.success) {
      await prisma.payoutSettlement.update({
        where: { paymentId },
        data: { status: "gateway_failed", attempts: { increment: 1 }, lastError: payoutResult.error || "Payout failed" },
      });
      await prisma.payment.update({ where: { id: paymentId }, data: { vendorPayoutStatus: "failed" } }).catch(() => {});
      throw new Error(payoutResult.error || "Payout failed");
    }

    payoutId = payoutResult.payoutId;
    payoutStatus = payoutResult.status;

    // RazorpayX has accepted the transfer. Record that fact before doing
    // anything else — if the process dies on the very next line, the next
    // run sees "gateway_confirmed" and checks this payout instead of
    // creating another.
    await prisma.payoutSettlement.update({
      where: { paymentId },
      data: { status: "gateway_confirmed", gatewayPayoutId: payoutId, attempts: { increment: 1 } },
    });
  }

  if (payoutStatus !== PAID_PAYOUT_STATE) {
    // Accepted but not paid yet (queued for balance, pending approval,
    // processing at the bank). Telling the vendor "paid" now would be false:
    // a queued payout can still be cancelled. The payment stays
    // "processing" and reconcileInFlightPayouts() finishes it later.
    await prisma.payment.update({ where: { id: paymentId }, data: { vendorPayoutId: payoutId } }).catch(() => {});
    Logger.info(`[Payout Worker] Payout ${payoutId} for Payment ${paymentId} is ${payoutStatus}; will check again.`);
    return;
  }

  try {
    // Conditional, so a job and the reconciler finishing the same payout at
    // once can't both notify the vendor. The settlement is marked first: if
    // the payment update below fails, the "settled" branch at the top of
    // the next run repairs it.
    const { count } = await prisma.payoutSettlement.updateMany({
      where: { paymentId, status: { in: ["gateway_confirmed", "reconciliation_needed"] } },
      data: { status: "settled", gatewayPayoutId: payoutId },
    });

    await prisma.payment.update({
      where: { id: paymentId },
      data: { vendorPayoutStatus: "paid", vendorPayoutId: payoutId },
    });

    if (count === 0) return; // someone else finished it

    // Previously rendered "₹undefined ..." whenever vendorAmount was null;
    // the template drops the amount clause entirely rather than guessing.
    const payoutNotification = renderNotification(NOTIFICATION_TYPES.PAYOUT_SETTLED, {
      amount: payment.vendorAmount,
      serviceName: payment.booking?.service?.name,
      bookingId: payment.bookingId ?? payment.booking?.id,
      paymentId,
    });
    await createNotification(
      vendorId,
      payoutNotification.title,
      payoutNotification.body,
      { type: payoutNotification.type, data: payoutNotification.data }
    );

    Logger.info(`[Payout Worker] Payout successful for Payment ID: ${paymentId}`);
  } catch (bookkeepingError) {
    Logger.error(
      `[Payout Worker] Gateway payout ${payoutId} succeeded for Payment ${paymentId} but bookkeeping failed: ${bookkeepingError.message}. Flagged for manual reconciliation, not retried automatically.`
    );
    await prisma.payoutSettlement.update({
      where: { paymentId },
      data: { status: "reconciliation_needed", lastError: bookkeepingError.message },
    }).catch(() => {});
    // Deliberately not rethrown: the money has already moved, so a retry
    // here would be pointless at best (gatewayAlreadyConfirmed makes it a
    // safe status check) and confusing at worst.
  }
};

/**
 * Why this payout must not be sent right now, or null if it may. Re-reads
 * refunds from the database rather than trusting the job snapshot.
 */
const payoutStopReason = async (payment) => {
  if (payment.status !== "success") return `payment is ${payment.status}`;
  const bookingStatus = payment.booking?.status;
  if (PAYOUT_DEAD_BOOKING_STATUSES.includes(bookingStatus)) return `booking is ${bookingStatus}`;
  if (!PAYOUT_READY_BOOKING_STATUSES.includes(bookingStatus)) {
    return `job not finished (booking is ${bookingStatus ?? "missing"})`;
  }
  const openRefund = await prisma.refund.findFirst({
    where: { paymentId: payment.id, status: { in: PAYOUT_BLOCKING_STATUSES } },
    select: { id: true, status: true },
  });
  if (openRefund) return `refund ${openRefund.id} is ${openRefund.status}`;
  return null;
};

/**
 * Payout ids RazorpayX refused for this settlement, kept in gatewayResponse
 * (a JSON string). Their count picks the next idempotency key.
 */
const refusedPayoutIds = (settlement) => {
  try {
    const parsed = JSON.parse(settlement.gatewayResponse || "{}");
    return Array.isArray(parsed.refusedPayoutIds) ? parsed.refusedPayoutIds : [];
  } catch {
    return [];
  }
};

/**
 * Marks a payout RazorpayX refused (rejected/failed/cancelled/reversed):
 * no money with the vendor, payment "failed" so it can be re-triggered, and
 * the refused id remembered so the next attempt uses a new idempotency key.
 */
const recordRefusedPayout = async (paymentId, settlement, payoutId, reason, { countAttempt = false } = {}) => {
  const refused = refusedPayoutIds(settlement);
  if (payoutId && !refused.includes(payoutId)) refused.push(payoutId);
  await prisma.payoutSettlement.update({
    where: { paymentId },
    data: {
      status: "gateway_failed",
      gatewayResponse: JSON.stringify({ refusedPayoutIds: refused }),
      lastError: reason,
      ...(countAttempt ? { attempts: { increment: 1 } } : {}),
    },
  });
  await prisma.payment.update({ where: { id: paymentId }, data: { vendorPayoutStatus: "failed" } }).catch(() => {});
  Logger.error(`[Payout Worker] Payout for Payment ${paymentId} refused by RazorpayX, not retried automatically: ${reason}`);
};

/**
 * reconcileInFlightPayouts
 *
 * Finishes payouts RazorpayX accepted but had not processed yet. There is no
 * payout webhook route, so this polls: each "gateway_confirmed" settlement is
 * re-run through processPayoutJob, which checks the payout's real status and
 * marks it paid, refused, or leaves it for the next tick. Run from the
 * 5-minute maintenance cron in server.js. Never throws.
 */
export const reconcileInFlightPayouts = async ({ limit = 50 } = {}) => {
  let settlements = [];
  try {
    settlements = await prisma.payoutSettlement.findMany({
      where: { status: "gateway_confirmed", gatewayPayoutId: { not: null } },
      orderBy: { updatedAt: "asc" },
      take: limit,
      include: { payment: { include: { booking: { include: { service: true } } } } },
    });
  } catch (err) {
    Logger.error(`[Payout Reconcile] Could not load in-flight payouts: ${err.message}`);
    return { checked: 0 };
  }

  for (const s of settlements) {
    const vendorId = s.payment?.booking?.service?.vendorId;
    if (!vendorId) {
      Logger.error(`[Payout Reconcile] Payment ${s.paymentId} has no vendor; skipped.`);
      continue;
    }
    try {
      await processPayoutJob({ data: { paymentId: s.paymentId, vendorId, bookingId: s.payment.bookingId } });
    } catch (err) {
      Logger.warn(`[Payout Reconcile] Payment ${s.paymentId}: ${err.message}`);
    }
  }
  return { checked: settlements.length };
};

export default processPayoutJob;
