import { Worker } from "bullmq";
import redisConnection from "../util/redis.js";
import prisma from "../util/prisma.js";
import { initiateVendorPayout } from "../util/payoutHelper.js";
import { createNotification } from "../util/notificationHelper.js";
import Logger from "../util/logger.js";

const payoutWorker = new Worker(
  "payoutQueue",
  async (job) => {
    const { paymentId, vendorId, bookingId } = job.data;

    Logger.info(`[Payout Worker] Processing payout for Payment ID: ${paymentId}`);

    try {
      // 1. Fetch payment details
      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        include: {
          booking: {
            include: {
              service: true
            }
          }
        }
      });

      if (!payment) {
        throw new Error(`Payment ${paymentId} not found`);
      }

      if (payment.vendorPayoutStatus === "paid") {
        Logger.info(`[Payout Worker] Payment ${paymentId} already paid. Skipping.`);
        return;
      }

      // 2. Execute Payout
      const payoutResult = await initiateVendorPayout(payment, vendorId);

      if (payoutResult.success) {
        // 3. Update database
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            vendorPayoutStatus: "paid",
            vendorPayoutId: payoutResult.payoutId
          }
        });

        // 4. Notify Vendor
        await createNotification(
          vendorId,
          "💰 Payment Received!",
          `₹${payment.vendorAmount} has been transferred to your account for ${payment.booking.service.name}`
        );

        Logger.info(`[Payout Worker] Payout successful for Payment ID: ${paymentId}`);
      } else {
        throw new Error(payoutResult.error || "Payout failed");
      }
    } catch (error) {
      Logger.error(`[Payout Worker] Error processing payout ${paymentId}: ${error.message}`);
      
      // Update status to failed in DB so admin can see, but BullMQ will still retry based on 'attempts'
      await prisma.payment.update({
        where: { id: paymentId },
        data: { vendorPayoutStatus: "failed" }
      }).catch(() => {}); // Ignore error if update fails

      throw error; // Rethrow to trigger BullMQ retry
    }
  },
  {
    connection: redisConnection,
    concurrency: 5,
  }
);

payoutWorker.on("completed", (job) => {
  Logger.info(`[Payout Worker] Job ${job.id} completed`);
});

payoutWorker.on("failed", (job, err) => {
  Logger.error(`[Payout Worker] Job ${job.id} failed: ${err.message}`);
});

export default payoutWorker;
