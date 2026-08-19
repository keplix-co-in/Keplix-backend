import 'dotenv/config';
import { env } from "./config/env.js";
import { createServer } from "http";

import app from "./app.js";
import { initSocket } from "./socket.js";
import Logger from "./util/logger.js";
import bookingStatusManager from "./util/bookingStatusManager.js";
import refundReconciler from "./util/refundReconciler.js";
import { startPaymentReconciliation } from "./util/paymentReconciliation.js";
import { scheduleOtpCleanup, stopOtpCleanup } from "./queues/otpCleanupQueue.js";
import cron from "node-cron";
import {
  registerJobHandler,
  runDueJobs,
  reclaimStuckJobs,
  pruneCompletedJobs,
  JOB_TYPES,
} from "./util/jobQueue.js";
import { processNotificationJob } from "./workers/notificationProcessor.js";
import { processPayoutJob } from "./workers/payoutProcessor.js";

/**
 * Whether THIS process runs background jobs. Defaults to true, so a plain
 * `node server.js` runs everything.
 *
 * Set RUN_WORKERS=false on extra web instances if you would rather one process
 * own the dispatching. It is only a preference, not a correctness requirement:
 * jobs are claimed with FOR UPDATE SKIP LOCKED (util/jobQueue.js), so running
 * the dispatcher on every instance is safe -- no job is handed out twice. This
 * is a real improvement on the Redis setup it replaces, where each additional
 * instance multiplied a fixed idle polling cost.
 */
const RUN_WORKERS = env.RUN_WORKERS !== "false";

// How often to look for due jobs. This is the one real behavioural difference
// from BullMQ: dispatch is polled rather than pushed, so a job starts within a
// tick instead of immediately. 10s is well inside what these jobs need -- the
// BullMQ workers' own idle poll had already been widened to 120s -- and unlike
// Redis, an empty poll here is a single indexed Postgres query against a
// database this process is already connected to, costing nothing metered.
const JOB_POLL_SECONDS = 10;

let jobDispatchTask = null;
let jobMaintenanceTask = null;

/**
 * Registers the job handlers and starts the dispatch loop.
 * @returns {void}
 */
const startJobDispatcher = () => {
  registerJobHandler(JOB_TYPES.NOTIFICATION, processNotificationJob);
  registerJobHandler(JOB_TYPES.VENDOR_PAYOUT, processPayoutJob);

  // runDueJobs never throws, so a bad tick cannot kill the schedule.
  jobDispatchTask = cron.schedule(`*/${JOB_POLL_SECONDS} * * * * *`, async () => {
    await runDueJobs();
  });

  // Housekeeping: recover jobs orphaned by a process that died mid-handler
  // (the equivalent of BullMQ's stalled-job check) and drop old completed rows.
  // Failed rows are kept deliberately -- they are the operator's audit trail.
  jobMaintenanceTask = cron.schedule("*/5 * * * *", async () => {
    await reclaimStuckJobs();
    await pruneCompletedJobs();
  });

  Logger.info(`Background job dispatcher started (every ${JOB_POLL_SECONDS}s).`);
};

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
  if (RUN_WORKERS) {
    startJobDispatcher();
    scheduleOtpCleanup().catch((err) => Logger.error('Failed to schedule cleanup job:', err));
  } else {
    Logger.info('RUN_WORKERS=false — background jobs not dispatched by this process.');
  }
  startPaymentReconciliation();
});

// --- GRACEFUL SHUTDOWN ---
const gracefulShutdown = () => {
  Logger.info('SIGTERM/SIGINT received. Shutting down gracefully...');

  bookingStatusManager.stop();
  refundReconciler.stop();
  stopOtpCleanup();

  // Stopping the schedules is all that is needed now. There are no queue
  // connections to drain: a job in flight is a Postgres row in 'processing',
  // and if this process dies before finishing it, reclaimStuckJobs picks it
  // back up. Handlers are idempotent, which is what makes that safe.
  jobDispatchTask?.stop();
  jobMaintenanceTask?.stop();

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