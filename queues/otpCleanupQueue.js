import { Queue } from "bullmq";
import redisConnection from "../util/redis.js";

export const otpCleanupQueue = new Queue("otpCleanupQueue", {
  connection: redisConnection,
});

/**
 * scheduleOtpCleanup
 *
 * Registers a repeatable BullMQ job (via cron pattern) that prunes stale
 * EmailOTP rows. Rows are never deleted by the OTP-send flow except when a
 * new OTP is requested for the same email, so verified/expired rows for
 * addresses that don't request another OTP would otherwise accumulate
 * forever. Idempotent — safe to call on every server start, BullMQ
 * de-duplicates repeatable jobs with the same key.
 */
export const scheduleOtpCleanup = async () => {
  await otpCleanupQueue.add(
    "prune-expired-email-otps",
    {},
    {
      repeat: { pattern: "0 * * * *" }, // hourly, on the hour
      removeOnComplete: true,
      removeOnFail: true,
    }
  );
};
