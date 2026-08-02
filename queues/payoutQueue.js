import { Queue } from "bullmq";
import redisConnection from "../util/redis.js";

export const payoutQueue = new Queue("payoutQueue", {
  connection: redisConnection,
});

/**
 * addPayoutJob
 *
 * Enqueues a vendor payout job on the BullMQ `payoutQueue`, picked up by
 * `payoutWorker` (workers/payoutWorker.js) to actually call the payout
 * gateway. Retries up to 5 times with exponential backoff on failure.
 *
 * Params:
 *   data.paymentId - Payment.id to settle
 *   data.vendorId  - User.id of the vendor receiving the payout
 *   data.bookingId - Booking.id the payment is tied to (used for notifications/logging)
 */
export const addPayoutJob = async (data) => {
  await payoutQueue.add("vendor-payout", data, {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  });
};
