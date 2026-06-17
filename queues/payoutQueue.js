import { Queue } from "bullmq";
import redisConnection from "../util/redis.js";

export const payoutQueue = new Queue("payoutQueue", {
  connection: redisConnection,
});

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
