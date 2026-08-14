import { Queue } from "bullmq";
import redisConnection from "../util/redis.js";

export const notificationQueue = new Queue("notificationQueue", {
  connection: redisConnection,
});

export const addNotificationJob = async (data) => {
  await notificationQueue.add("booking-notification", data, {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
  });
};
