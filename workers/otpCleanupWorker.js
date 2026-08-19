import { Worker } from "bullmq";
import redisConnection from "../util/redis.js";
import prisma from "../util/prisma.js";
import Logger from "../util/logger.js";

// Verified OTPs are kept for a short retention window after use (in case a
// support/audit lookup needs the record), then pruned along with anything
// past its expiry regardless of verified status.
const VERIFIED_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

const worker = new Worker(
  "otpCleanupQueue",
  async (job) => {
    const now = new Date();
    const verifiedCutoff = new Date(now.getTime() - VERIFIED_RETENTION_MS);

    const result = await prisma.emailOTP.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: now } },
          { verified: true, createdAt: { lt: verifiedCutoff } },
        ],
      },
    });

    Logger.info(`[OTP Cleanup] Pruned ${result.count} stale EmailOTP row(s)`);
    return result.count;
  },
  {
    connection: redisConnection,
    // This queue only ever gets ONE job an hour (the repeatable cron job in
    // queues/otpCleanupQueue.js), so BullMQ's default 5s long-poll was
    // wasted Redis traffic essentially 100% of the time — see the matching
    // comment in notificationWorker.js for the actual cost this incurred.
    drainDelay: 60,
    stalledInterval: 300_000,
  }
);

worker.on("failed", (job, err) => {
  Logger.error(`[OTP Cleanup] Job ${job.id} failed: ${err.message}`);
});

export default worker;
