import prisma from "../util/prisma.js";
import { initiateVendorPayout } from "../util/payoutHelper.js";
import { createNotification } from "../util/notificationHelper.js";
import Logger from "../util/logger.js";

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

  // "gateway_confirmed" and "reconciliation_needed" both mean the gateway
  // call already succeeded on a prior attempt — only the bookkeeping after
  // it is unfinished. Re-running initiateVendorPayout here would be a
  // second real transfer, so it must be skipped in both cases.
  const gatewayAlreadyConfirmed =
    settlement.status === "gateway_confirmed" || settlement.status === "reconciliation_needed";

  let payoutResult;
  if (gatewayAlreadyConfirmed) {
    payoutResult = { success: true, payoutId: settlement.gatewayPayoutId };
  } else {
    try {
      payoutResult = await initiateVendorPayout(payment, vendorId);
    } catch (gatewayError) {
      await prisma.payoutSettlement.update({
        where: { paymentId },
        data: { status: "gateway_failed", attempts: { increment: 1 }, lastError: gatewayError.message },
      });
      await prisma.payment.update({ where: { id: paymentId }, data: { vendorPayoutStatus: "failed" } }).catch(() => {});
      throw gatewayError; // real gateway failure — safe to let BullMQ retry
    }

    if (!payoutResult.success) {
      await prisma.payoutSettlement.update({
        where: { paymentId },
        data: { status: "gateway_failed", attempts: { increment: 1 }, lastError: payoutResult.error || "Payout failed" },
      });
      await prisma.payment.update({ where: { id: paymentId }, data: { vendorPayoutStatus: "failed" } }).catch(() => {});
      throw new Error(payoutResult.error || "Payout failed");
    }

    // The transfer has happened. Record that fact before doing anything
    // else — if the process dies on the very next line, the next run sees
    // "gateway_confirmed" and knows not to call the gateway again.
    await prisma.payoutSettlement.update({
      where: { paymentId },
      data: { status: "gateway_confirmed", gatewayPayoutId: payoutResult.payoutId, attempts: { increment: 1 } },
    });
  }

  try {
    await prisma.payment.update({
      where: { id: paymentId },
      data: { vendorPayoutStatus: "paid", vendorPayoutId: payoutResult.payoutId },
    });

    await prisma.payoutSettlement.update({ where: { paymentId }, data: { status: "settled" } });

    await createNotification(
      vendorId,
      "💰 Payment Received!",
      `₹${payment.vendorAmount} has been transferred to your account for ${payment.booking.service.name}`
    );

    Logger.info(`[Payout Worker] Payout successful for Payment ID: ${paymentId}`);
  } catch (bookkeepingError) {
    Logger.error(
      `[Payout Worker] Gateway payout ${payoutResult.payoutId} succeeded for Payment ${paymentId} but bookkeeping failed: ${bookkeepingError.message}. Flagged for manual reconciliation, not retried automatically.`
    );
    await prisma.payoutSettlement.update({
      where: { paymentId },
      data: { status: "reconciliation_needed", lastError: bookkeepingError.message },
    }).catch(() => {});
    // Deliberately not rethrown: the money has already moved, so a BullMQ
    // retry here would be pointless at best (gatewayAlreadyConfirmed makes
    // it a safe no-op) and confusing at worst. This needs a human to look
    // at PayoutSettlement rows in "reconciliation_needed", not a retry loop.
  }
};

export default processPayoutJob;
