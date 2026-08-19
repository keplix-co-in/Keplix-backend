import cron from 'node-cron';
import prisma from './prisma.js';
import Logger from './logger.js';

/**
 * Refund Reconciler
 *
 * Surfaces refunds whose fate the system cannot determine on its own.
 *
 * This job REPORTS. It deliberately does not retry anything.
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
}

export default new RefundReconciler();
