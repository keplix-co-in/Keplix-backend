import { Worker } from "bullmq";
import redisConnection from "../util/redis.js";
import { createNotification } from "../util/notificationHelper.js";
import { getIO } from "../socket.js";
import Logger from "../util/logger.js";

const worker = new Worker(
  "notificationQueue",
  async (job) => {
    const { type, recipientId, title, body, metadata, socketEvent, socketData, room } = job.data;

    Logger.info(`[Worker] Processing job ${job.id} of type ${type}`);

    try {
      // 1. Handle DB/Push Notification
      if (recipientId && title && body) {
        await createNotification(recipientId, title, body, metadata);
        Logger.debug(`[Worker] Notification created for user ${recipientId}`);
      }

      // 2. Handle Socket.io Emit
      if (socketEvent && socketData) {
        const io = getIO();
        if (room) {
          io.to(room).emit(socketEvent, socketData);
          Logger.debug(`[Worker] Socket event ${socketEvent} emitted to room ${room}`);
        } else if (recipientId) {
          io.to(`user_${recipientId}`).emit(socketEvent, socketData);
          Logger.debug(`[Worker] Socket event ${socketEvent} emitted to user_${recipientId}`);
        }
      }
    } catch (error) {
      Logger.error(`[Worker] Failed to process job ${job.id}: ${error.message}`);
      throw error; // Let BullMQ handle the retry
    }
  },
  { connection: redisConnection }
);

worker.on("completed", (job) => {
  Logger.info(`[Worker] Job ${job.id} completed successfully`);
});

worker.on("failed", (job, err) => {
  Logger.error(`[Worker] Job ${job.id} failed: ${err.message}`);
});

export default worker;
