import { enqueueJob, JOB_TYPES } from "../util/jobQueue.js";

/**
 * addNotificationJob
 *
 * Enqueues a notification job. Previously a BullMQ `Queue.add` against Redis;
 * now a row in Postgres (see util/jobQueue.js for why Redis was removed).
 *
 * The signature is unchanged so that every existing caller works untouched.
 * Retry semantics are preserved too: 3 attempts with exponential backoff from a
 * 1s base, matching the old `{ attempts: 3, backoff: { type: "exponential",
 * delay: 1000 } }`.
 *
 * @param {object} data - Job payload; reaches processNotificationJob as job.data.
 * @returns {Promise<{id: number}>}
 */
export const addNotificationJob = async (data) => {
  return enqueueJob(JOB_TYPES.NOTIFICATION, data, { maxAttempts: 3 });
};

export default addNotificationJob;
