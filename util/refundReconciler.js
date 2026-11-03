import cron from 'node-cron';
import prisma from './prisma.js';
import Logger from './logger.js';

/**
 * Refund Reconciler
 *
 * Surfaces refunds whose fate the system cannot determine on its own.
 *
 * This job mostly REPORTS. It never retries a refund.
 *
 * The one thing it settles by itself (2026-11-03): refunds Razorpay accepted
 * as 'pending' ('gateway_confirmed' here) whose refund.processed /
 * refund.failed webhook never arrived. It asks Razorpay for the refund's
 * state and applies the answer, exactly as the webhook would. That is safe
 * because it only reads Razorpay's final word -- it never calls the refund
 * API, so it cannot refund anyone twice.
 *
 * refundService refuses to auto-retry a row stuck 'initiated' because whether
 * that refund reached the gateway is genuinely unknown, and retrying on a
 * guess can refund a customer twice. A background job that quietly "fixed"
 * those rows would undo that safeguard at the exact moment nobody is watching.
 * So the output here is an alert for a human, not an action.
 *
 * The two conditions it watches:
 * - 'initiated' beyond STUCK_AFTER_MINUTES — the gateway call was made but
 *   never came back, or the process died mid-call.
 * - 'reconciliation_needed' — the gateway refund succeeded but our own
 *   bookkeeping afterwards failed, so our records understate what was paid out.
 */

// Generous enough that a slow-but-succeeding gateway call is not reported as
// stuck. Razorpay refund calls are normally sub-second.
const STUCK_AFTER_MINUTES = 15;

// A 'pending' refund normally settles in seconds to hours; the webhook
// usually beats this. Waiting first avoids racing a webhook in flight.
const PENDING_CHECK_AFTER_MINUTES = 10;

class RefundReconciler {
  constructor() {
    this.isRunning = false;
    this.task = null;
  }

  start() {
    if (this.isRunning) {
      Logger.info('Refund Reconciler is already running');
      return;
    }

    Logger.info('Starting Refund Reconciler...');

    // Every 15 minutes. These are rare, human-actioned cases — checking more
    // often would add Redis/DB load for no faster resolution.
    this.task = cron.schedule('*/15 * * * *', async () => {
      try {
        await this.reportUnresolvedRefunds();
        await this.settlePendingRefunds();
      } catch (error) {
        Logger.error(`Refund Reconciler error: ${error.message}`);
      }
    });

    this.isRunning = true;
  }

  stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }
    this.isRunning = false;
    Logger.info('Refund Reconciler stopped');
  }

  async reportUnresolvedRefunds() {
    const cutoff = new Date(Date.now() - STUCK_AFTER_MINUTES * 60 * 1000);

    const stuck = await prisma.refund.findMany({
      where: { status: 'initiated', createdAt: { lt: cutoff } },
      select: { id: true, paymentId: true, amount: true, createdAt: true, idempotencyKey: true },
    });

    for (const refund of stuck) {
      Logger.error(
        `[MANUAL ACTION] Refund ${refund.id} (payment ${refund.paymentId}, ₹${refund.amount}) has been ` +
        `'initiated' since ${refund.createdAt.toISOString()}. Whether it reached the gateway is unknown — ` +
        `check Razorpay for receipt "${refund.idempotencyKey}" before re-issuing. Do NOT retry blindly.`
      );
    }

    const needsReconciliation = await prisma.refund.findMany({
      where: { status: 'reconciliation_needed' },
      select: { id: true, paymentId: true, amount: true, gatewayRefundId: true, lastError: true },
    });

    for (const refund of needsReconciliation) {
      Logger.error(
        `[MANUAL ACTION] Refund ${refund.id} (payment ${refund.paymentId}, ₹${refund.amount}) succeeded at ` +
        `the gateway (${refund.gatewayRefundId}) but our bookkeeping failed: ${refund.lastError}. ` +
        `The customer HAS been refunded; our records do not reflect it.`
      );
    }

    if (stuck.length || needsReconciliation.length) {
      Logger.warn(
        `Refund Reconciler: ${stuck.length} stuck, ${needsReconciliation.length} awaiting reconciliation`
      );
    }

    return { stuck: stuck.length, needsReconciliation: needsReconciliation.length };
  }

  /**
   * Finishes 'gateway_confirmed' refunds by asking Razorpay what happened.
   * One failed lookup never stops the rest.
   */
  async settlePendingRefunds() {
    const cutoff = new Date(Date.now() - PENDING_CHECK_AFTER_MINUTES * 60 * 1000);
    const pending = await prisma.refund.findMany({
      where: { status: 'gateway_confirmed', gatewayRefundId: { not: null }, updatedAt: { lt: cutoff } },
      take: 50,
    });
    if (!pending.length) return { checked: 0, processed: 0, failed: 0 };

    // Loaded here, not at the top: refundService builds its Razorpay client
    // when imported, and this file is imported by server.js at startup.
    const { fetchGatewayRefund, applyGatewayRefundOutcome } = await import('../services/refundService.js');

    let processed = 0;
    let failed = 0;
    for (const refund of pending) {
      try {
        const entity = await fetchGatewayRefund(refund.gatewayRefundId);
        if (entity?.status === 'processed') {
          const { changed } = await applyGatewayRefundOutcome(refund, 'processed', entity);
          if (changed) processed += 1;
        } else if (entity?.status === 'failed') {
          const { changed } = await applyGatewayRefundOutcome(refund, 'failed', entity);
          if (changed) {
            failed += 1;
            Logger.error(`[MANUAL ACTION] Refund ${refund.id} (${refund.gatewayRefundId}) failed at Razorpay — customer has NOT been refunded.`);
          }
        }
        // Still 'pending' at Razorpay: leave it for the next run.
      } catch (error) {
        Logger.error(`Refund Reconciler: could not check refund ${refund.id} (${refund.gatewayRefundId}): ${error.message}`);
      }
    }

    if (processed || failed) {
      Logger.info(`Refund Reconciler: settled ${processed} processed, ${failed} failed of ${pending.length} pending`);
    }
    return { checked: pending.length, processed, failed };
  }
}

export default new RefundReconciler();
