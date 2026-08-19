import { enqueueJob, JOB_TYPES } from "../util/jobQueue.js";

/**
 * addPayoutJob
 *
 * Enqueues a vendor payout job, picked up by the Postgres job dispatcher (see
 * util/jobQueue.js) which calls workers/payoutProcessor.js to hit the payout
 * gateway. Previously a BullMQ `Queue.add` against Redis.
 *
 * Retries up to 5 times with exponential backoff from a 5s base, matching the
 * old `{ attempts: 5, backoff: { type: "exponential", delay: 5000 } }`.
 *
 * Safety note, since this moves money: the retry guarantee here was never what
 * made payouts safe. processPayoutJob is idempotent through the durable
 * PayoutSettlement state machine — it records "gateway_confirmed" the instant
 * the transfer succeeds and refuses to call the gateway again for any
 * settlement at or past that state, and a failure in the bookkeeping AFTER the
 * transfer is flagged "reconciliation_needed" rather than retried. Those
 * guarantees live in the database and are untouched by this change; the queue
 * only ever decided WHEN to call, never whether it was safe to.
 *
 * Params:
 *   data.paymentId - Payment.id to settle
 *   data.vendorId  - User.id of the vendor receiving the payout
 *   data.bookingId - Booking.id the payment is tied to (used for notifications/logging)
 *
 * @param {{paymentId: number, vendorId: number, bookingId?: number}} data
 * @returns {Promise<{id: number}>}
 */
export const addPayoutJob = async (data) => {
  return enqueueJob(JOB_TYPES.VENDOR_PAYOUT, data, { maxAttempts: 5 });
};

export default addPayoutJob;
