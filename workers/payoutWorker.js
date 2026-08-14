import { Worker } from "bullmq";
import redisConnection from "../util/redis.js";
import Logger from "../util/logger.js";
import { processPayoutJob } from "./payoutProcessor.js";

/**
 * payoutWorker
 *
 * BullMQ wiring only. The payout logic itself lives in payoutProcessor.js so
 * it can be exercised directly by tests without a Redis connection or a live
 * queue — importing this module constructs a Worker and connects to Redis,
 * which is exactly what a test must avoid.
 *
 * Retry policy is on the queue side (queues/payoutQueue.js): 5 attempts with
 * exponential backoff. Note the processor deliberately does NOT rethrow when
 * the gateway succeeded but bookkeeping failed, so those cases never consume
 * a retry — they are flagged "reconciliation_needed" for a human instead.
 */
const payoutWorker = new Worker("payoutQueue", processPayoutJob, {
  connection: redisConnection,
  concurrency: 5,
});

payoutWorker.on("completed", (job) => {
  Logger.info(`[Payout Worker] Job ${job.id} completed`);
});

payoutWorker.on("failed", (job, err) => {
  Logger.error(`[Payout Worker] Job ${job?.id} failed: ${err.message}`);
});

export default payoutWorker;
