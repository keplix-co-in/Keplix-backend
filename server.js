import 'dotenv/config';
import { env } from "./config/env.js";
import { createServer } from "http";

import app from "./app.js";
import { initSocket } from "./socket.js";
import Logger from "./util/logger.js";
import bookingStatusManager from "./util/bookingStatusManager.js";
import refundReconciler from "./util/refundReconciler.js";
import { startPaymentReconciliation } from "./util/paymentReconciliation.js";
import { scheduleOtpCleanup } from "./queues/otpCleanupQueue.js";
import notificationWorker from "./workers/notificationWorker.js";
import payoutWorker from "./workers/payoutWorker.js";
import otpCleanupWorker from "./workers/otpCleanupWorker.js";

/**
 * Process entrypoint.
 *
 * The Express app itself lives in app.js so it can be imported by tests
 * without any of the side effects below. Everything here is a side effect:
 * binding a port, opening Socket.IO, starting BullMQ workers and cron jobs.
 */

const httpServer = createServer(app);

// Socket.IO needs the http server, so it's wired here rather than in app.js.
// Consumers read it via req.app.get("io") and skip emitting when it's absent,
// which is what lets app.js work standalone under test.
const io = initSocket(httpServer);
app.set("io", io);

// --- SERVER START ---
const PORT = env.PORT || 8080;

httpServer.listen(PORT, '0.0.0.0', () => {
  Logger.info(`=================================`);
  Logger.info(`🚀 Keplix Backend Running`);
  Logger.info(`🌍 URL: http://0.0.0.0:${PORT}`);
  Logger.info(`⚙️ Mode: ${env.NODE_ENV}`);
  Logger.info(`=================================`);

  bookingStatusManager.start();
  refundReconciler.start();
  scheduleOtpCleanup().catch((err) => Logger.error('Failed to schedule OTP cleanup job:', err));
  startPaymentReconciliation();
});

// --- GRACEFUL SHUTDOWN ---
const gracefulShutdown = () => {
  Logger.info('SIGTERM/SIGINT received. Shutting down gracefully...');

  bookingStatusManager.stop();
  refundReconciler.stop();

  if (notificationWorker) {
    notificationWorker.close().then(() => {
      Logger.info('Notification worker closed.');
    }).catch(err => {
      Logger.error('Error closing notification worker:', err);
    });
  }

  if (payoutWorker) {
    payoutWorker.close().then(() => {
      Logger.info('Payout worker closed.');
    }).catch(err => {
      Logger.error('Error closing payout worker:', err);
    });
  }

  if (otpCleanupWorker) {
    otpCleanupWorker.close().then(() => {
      Logger.info('OTP cleanup worker closed.');
    }).catch(err => {
      Logger.error('Error closing OTP cleanup worker:', err);
    });
  }

  httpServer.close(() => {
    Logger.info('HTTP server closed.');
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

process.on('unhandledRejection', (reason, promise) => {
  Logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  Logger.error('Uncaught Exception:', error);
});