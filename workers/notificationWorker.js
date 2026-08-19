import { Worker } from "bullmq";
import redisConnection from "../util/redis.js";
import { createNotification } from "../util/notificationHelper.js";
import { sendJobSheetNotification } from "../services/walkInNotificationService.js";
import prisma from "../util/prisma.js";
import { getIO } from "../socket.js";
import Logger from "../util/logger.js";

const worker = new Worker(
  "notificationQueue",
  async (job) => {
    const { type, recipientId, title, body, metadata, socketEvent, socketData, room } = job.data;

    Logger.info(`[Worker] Processing job ${job.id} of type ${type}`);

    // Walk-in jobs have no User row to notify — the recipient is a raw phone
    // number, not recipientId. This is a distinct job shape from every other
    // notification handled below, so it branches out early rather than
    // trying to fit createNotification's user-centric assumptions.
    if (type === "WALK_IN_JOB_SHEET") {
      const { walkInJobId, customerName, customerPhone, vendorName, token } = job.data;
      try {
        const result = await sendJobSheetNotification({ customerName, customerPhone, vendorName, token });
        await prisma.walkInJob.update({
          where: { id: walkInJobId },
          data: {
            notification_status: result.whatsapp || result.sms ? "sent" : "failed",
          },
        }).catch((err) => {
          // Delivery already attempted; a failure to persist the status must
          // not turn into a BullMQ retry that resends the message.
          Logger.error(`[Worker] Failed to record notification status for WalkInJob ${walkInJobId}: ${err.message}`);
        });
      } catch (error) {
        Logger.error(`[Worker] WALK_IN_JOB_SHEET job ${job.id} failed: ${error.message}`);
        // Deliberately not re-thrown: sendJobSheetNotification already
        // swallows its own errors, and the notification vendor's-eye view
        // (resend button, see walkInJobController.js) is a better recovery
        // path than an automatic BullMQ retry hammering Twilio.
      }
      return;
    }

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
  {
    connection: redisConnection,
    // Idle long-poll timeout. NOT job latency.
    //
    // The worker blocks on bzpopmin(marker, blockTimeout) and, when the queue
    // is empty, blockTimeout is just max(drainDelay, minimumBlockTimeout)
    // (bullmq/dist/cjs/classes/worker.js:447 and :510). Queue.add writes that
    // marker key, which wakes the blocked client IMMEDIATELY -- so raising
    // drainDelay delays nothing. It only decides how often an idle worker
    // re-issues the blocking call.
    //
    // That distinction matters because idle polling, not real traffic, is what
    // exhausted Upstash's 500k/month command cap -- twice. At the previous
    // settings the three workers spent ~484k commands/month doing nothing:
    // payout 259k (10s), notification 130k (20s), otpCleanup 43k (60s), plus
    // ~52k in stalled-job checks. That is 97% of the cap before a single user
    // makes a request, and when the cap is hit every Redis command fails --
    // which, because the auth blacklist check in middleware/authMiddleware.js
    // fails closed, 401s every authenticated request. A billing limit becomes
    // a total auth outage.
    //
    // 120s idle / 300s stalled puts all three workers at ~91k commands/month.
    // Drop to 60s if long blocks turn out to cause reconnect churn against
    // Upstash's idle-connection timeout (watch the Upstash command graph).
    drainDelay: 120,
    stalledInterval: 300_000,
  }
);

worker.on("completed", (job) => {
  Logger.info(`[Worker] Job ${job.id} completed successfully`);
});

worker.on("failed", (job, err) => {
  Logger.error(`[Worker] Job ${job.id} failed: ${err.message}`);
});

export default worker;
