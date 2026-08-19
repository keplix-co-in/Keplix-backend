import { createNotification } from "../util/notificationHelper.js";
import { sendJobSheetNotification } from "../services/walkInNotificationService.js";
import prisma from "../util/prisma.js";
import { getIO } from "../socket.js";
import Logger from "../util/logger.js";

/**
 * processNotificationJob
 *
 * The notification logic, lifted verbatim out of the old BullMQ
 * workers/notificationWorker.js and kept in its own module with no queue or
 * Redis import, so it can be driven directly by tests and by the Postgres job
 * dispatcher. This mirrors how workers/payoutProcessor.js is already split from
 * its runner.
 *
 * Behaviour matches the BullMQ version, including which failures rethrow (and
 * so earn a retry) and which are deliberately swallowed, with ONE deliberate
 * change: the Socket.IO emit is now guarded. getIO() throws outright when
 * Socket.IO was never initialised (socket.js:34), which never happened while
 * the worker only ever ran inside server.js. A dispatcher can now run in a
 * process without sockets, and there a missing io would have failed -- and
 * retried -- a notification whose database row had already been written.
 *
 * job.data:
 *   type         - job discriminator; "WALK_IN_JOB_SHEET" takes a separate path
 *   recipientId  - User.id to notify (absent for walk-in jobs)
 *   title, body  - notification copy
 *   metadata     - optional extra data stored with the notification
 *   socketEvent  - optional Socket.IO event name to emit
 *   socketData   - payload for that event
 *   room         - optional room to emit to; defaults to `user_<recipientId>`
 *
 * @param {{id: number|string, data: object}} job
 * @returns {Promise<void>}
 */
export const processNotificationJob = async (job) => {
  const { type, recipientId, title, body, metadata, socketEvent, socketData, room } = job.data;

  Logger.info(`[Notification] Processing job ${job.id} of type ${type}`);

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
        // not turn into a retry that resends the message.
        Logger.error(`[Notification] Failed to record notification status for WalkInJob ${walkInJobId}: ${err.message}`);
      });
    } catch (error) {
      Logger.error(`[Notification] WALK_IN_JOB_SHEET job ${job.id} failed: ${error.message}`);
      // Deliberately not re-thrown: sendJobSheetNotification already
      // swallows its own errors, and the notification vendor's-eye view
      // (resend button, see walkInJobController.js) is a better recovery
      // path than an automatic retry hammering Twilio.
    }
    return;
  }

  try {
    // 1. Handle DB/Push Notification
    if (recipientId && title && body) {
      await createNotification(recipientId, title, body, metadata);
      Logger.debug(`[Notification] Notification created for user ${recipientId}`);
    }

    // 2. Handle Socket.io Emit
    //
    // getIO() throws when Socket.IO was never initialised — which is the case
    // in any process that did not boot server.js. Emitting is a best-effort
    // side channel next to the row created above, so a missing io must not
    // fail (and retry) a notification that has already been persisted.
    if (socketEvent && socketData) {
      try {
        const io = getIO();
        if (room) {
          io.to(room).emit(socketEvent, socketData);
          Logger.debug(`[Notification] Socket event ${socketEvent} emitted to room ${room}`);
        } else if (recipientId) {
          io.to(`user_${recipientId}`).emit(socketEvent, socketData);
          Logger.debug(`[Notification] Socket event ${socketEvent} emitted to user_${recipientId}`);
        }
      } catch (socketError) {
        Logger.warn(`[Notification] Socket emit skipped for job ${job.id}: ${socketError.message}`);
      }
    }
  } catch (error) {
    Logger.error(`[Notification] Failed to process job ${job.id}: ${error.message}`);
    throw error; // Let the dispatcher handle the retry
  }
};

export default processNotificationJob;
