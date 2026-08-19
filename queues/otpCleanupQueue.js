import cron from "node-cron";
import prisma from "../util/prisma.js";
import Logger from "../util/logger.js";

// Verified OTPs are kept for a short retention window after use (in case a
// support/audit lookup needs the record), then pruned along with anything
// past its expiry regardless of verified status.
const VERIFIED_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

let task = null;

/**
 * Prunes stale EmailOTP rows, and expired BlacklistedToken rows alongside them.
 *
 * Rows are never deleted by the OTP-send flow except when a new OTP is
 * requested for the same email, so verified/expired rows for addresses that
 * don't request another OTP would otherwise accumulate forever.
 *
 * BlacklistedToken is pruned here too because it is the same kind of chore and
 * wants the same schedule. That table is the Postgres replacement for what used
 * to be a Redis key with an EX expiry — Redis expired those rows for us, so
 * taking Redis away means someone has to, and a row whose expiresAt has passed
 * is meaningless (the JWT it names is rejected by signature-expiry anyway).
 *
 * @returns {Promise<{otps: number, tokens: number}>} Rows deleted from each table.
 */
export const pruneExpiredRecords = async () => {
  const now = new Date();
  const verifiedCutoff = new Date(now.getTime() - VERIFIED_RETENTION_MS);

  const otpResult = await prisma.emailOTP.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: now } },
        { verified: true, createdAt: { lt: verifiedCutoff } },
      ],
    },
  });

  const tokenResult = await prisma.blacklistedToken.deleteMany({
    where: { expiresAt: { lt: now } },
  });

  Logger.info(
    `[Cleanup] Pruned ${otpResult.count} stale EmailOTP row(s) and ${tokenResult.count} expired BlacklistedToken row(s)`
  );

  return { otps: otpResult.count, tokens: tokenResult.count };
};

/**
 * Schedules the hourly cleanup.
 *
 * This was a repeatable BullMQ job on a Redis-backed queue; it is now plain
 * node-cron, the same mechanism bookingStatusManager, paymentReconciliation and
 * refundReconciler already use in this codebase. A once-an-hour DELETE never
 * needed a distributed queue behind it — it needed a timer.
 *
 * Idempotent: calling it twice does not double-schedule.
 *
 * @returns {Promise<void>}
 */
export const scheduleOtpCleanup = async () => {
  if (task) return;

  task = cron.schedule("0 * * * *", async () => {
    try {
      await pruneExpiredRecords();
    } catch (error) {
      Logger.error(`[Cleanup] Hourly prune failed: ${error.message}`);
    }
  });

  Logger.info("[Cleanup] Hourly EmailOTP/BlacklistedToken prune scheduled");
};

/**
 * Stops the cleanup schedule, for graceful shutdown.
 * @returns {void}
 */
export const stopOtpCleanup = () => {
  if (task) {
    task.stop();
    task = null;
  }
};
