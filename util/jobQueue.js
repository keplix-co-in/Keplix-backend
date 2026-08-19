import prisma from "./prisma.js";
import Logger from "./logger.js";

/**
 * A Postgres-backed background job queue, replacing BullMQ + Redis.
 *
 * WHY: the three BullMQ workers each held an idle blocking poll open against
 * Redis continuously, costing ~484k commands/month before any real work
 * happened. That repeatedly exhausted the hosted Redis quota, and because a
 * quota error is a ReplyError rather than a connection error, BullMQ's fetch
 * loop spun on it without backing off and took the process down with it.
 * Postgres is already a hard dependency of every request path, so putting the
 * queue there removes a whole piece of paid infrastructure instead of tuning
 * it. One less service to pay for, one less service to be down.
 *
 * WHAT IS PRESERVED from the BullMQ behaviour it replaces:
 *   - durability: jobs survive a restart (they always were rows-in-waiting;
 *     now they are literally rows)
 *   - bounded retries with exponential backoff (attempts / maxAttempts)
 *   - at-most-once concurrent execution per job, across instances
 *   - handlers receive `{ id, data }`, so existing processors that read
 *     `job.data` work unchanged
 *
 * WHAT IS DIFFERENT, deliberately:
 *   - Dispatch is poll-based on a short interval rather than push-based, so a
 *     job starts within one tick (see JOB_POLL_SECONDS in server.js) instead
 *     of instantly. Every job here is a notification or a payout; none is
 *     latency-critical to the millisecond, and the previous drainDelay was
 *     already 120s.
 *   - There is no separate "delayed set" or rate limiter. Backoff is just a
 *     future `runAt`, which the same index already covers.
 */

/** Job type constants. Kept here so producers and the dispatcher cannot drift. */
export const JOB_TYPES = {
  NOTIFICATION: "notification",
  VENDOR_PAYOUT: "vendor-payout",
};

/** Registry of type -> handler, populated by registerJobHandler at boot. */
const handlers = new Map();

/**
 * Registers the function that processes a given job type.
 * @param {string} type - One of JOB_TYPES.
 * @param {(job: {id: number, data: object}) => Promise<unknown>} handler
 */
export const registerJobHandler = (type, handler) => {
  handlers.set(type, handler);
};

/**
 * Adds a job to the queue.
 *
 * Note there is no transaction here on purpose: callers enqueue AFTER their own
 * transaction has committed (see claimAndQueuePayout in services/payoutService.js),
 * so the job must not be tied to a transaction that may still roll back.
 *
 * @param {string} type - One of JOB_TYPES.
 * @param {object} payload - Serialisable job data; reaches the handler as job.data.
 * @param {object} [options]
 * @param {number} [options.maxAttempts=3] - Total tries before the job is marked failed.
 * @param {Date} [options.runAt] - Earliest run time; defaults to now.
 * @returns {Promise<{id: number}>} The created job row.
 */
export const enqueueJob = async (type, payload, { maxAttempts = 3, runAt } = {}) => {
  const job = await prisma.backgroundJob.create({
    data: {
      type,
      payload,
      maxAttempts,
      ...(runAt ? { runAt } : {}),
    },
    select: { id: true },
  });
  Logger.debug(`[JobQueue] Enqueued ${type} job ${job.id}`);
  return job;
};

/**
 * Exponential backoff, matching what the BullMQ configs specified: payouts used
 * a 5s base, notifications 1s. Base is per-job-type via the delay argument.
 * @param {number} attempts - Attempts made so far (1 after the first failure).
 * @param {number} baseDelayMs
 * @returns {Date} When the job should next become eligible.
 */
const nextRunAt = (attempts, baseDelayMs) => {
  const delayMs = baseDelayMs * Math.pow(2, Math.max(0, attempts - 1));
  // Cap at an hour so a persistently failing job doesn't drift out to days.
  return new Date(Date.now() + Math.min(delayMs, 60 * 60 * 1000));
};

const BASE_BACKOFF_MS = {
  [JOB_TYPES.NOTIFICATION]: 1000,
  [JOB_TYPES.VENDOR_PAYOUT]: 5000,
};

/**
 * Atomically claims up to `limit` due jobs for this process.
 *
 * FOR UPDATE SKIP LOCKED is what makes running the dispatcher on several
 * instances safe: concurrent claimers step over rows already locked by another
 * transaction instead of blocking on them or, worse, both taking the same job.
 * This is the guarantee BullMQ implemented with atomic Lua scripts, expressed
 * in the database that is already the source of truth.
 *
 * @param {number} limit - Maximum jobs to claim.
 * @returns {Promise<Array<{id: number, type: string, payload: object, attempts: number, maxAttempts: number}>>}
 */
const claimDueJobs = async (limit) => {
  return prisma.$queryRaw`
    UPDATE "BackgroundJob"
       SET status = 'processing', "updatedAt" = NOW()
     WHERE id IN (
       SELECT id
         FROM "BackgroundJob"
        WHERE status = 'pending'
          AND "runAt" <= NOW()
        ORDER BY "runAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, type, payload, attempts, "maxAttempts";
  `;
};

/**
 * Records the outcome of one job: completed, scheduled for another try, or
 * given up on.
 * @param {{id: number, type: string, attempts: number, maxAttempts: number}} job
 * @param {Error} error
 */
const recordFailure = async (job, error) => {
  const attempts = job.attempts + 1;
  const exhausted = attempts >= job.maxAttempts;
  const baseDelay = BASE_BACKOFF_MS[job.type] ?? 1000;

  await prisma.backgroundJob.update({
    where: { id: job.id },
    data: {
      attempts,
      lastError: String(error?.message ?? error).slice(0, 1000),
      ...(exhausted
        ? { status: "failed" }
        : { status: "pending", runAt: nextRunAt(attempts, baseDelay) }),
    },
  });

  if (exhausted) {
    Logger.error(
      `[JobQueue] ${job.type} job ${job.id} FAILED permanently after ${attempts} attempt(s): ${error?.message}`
    );
  } else {
    Logger.warn(
      `[JobQueue] ${job.type} job ${job.id} attempt ${attempts}/${job.maxAttempts} failed, will retry: ${error?.message}`
    );
  }
};

/**
 * Claims and runs one batch of due jobs. Safe to call concurrently and safe to
 * call when there is nothing to do (one indexed query, no work).
 *
 * Never throws: a dispatcher that throws would kill the cron tick that drives
 * it, silently stopping all background work. Errors are logged instead.
 *
 * @param {object} [options]
 * @param {number} [options.limit=20] - Maximum jobs per batch.
 * @returns {Promise<number>} How many jobs were processed (successfully or not).
 */
export const runDueJobs = async ({ limit = 20 } = {}) => {
  let jobs;
  try {
    jobs = await claimDueJobs(limit);
  } catch (error) {
    Logger.error(`[JobQueue] Failed to claim jobs: ${error.message}`);
    return 0;
  }

  if (!jobs.length) return 0;

  for (const job of jobs) {
    const handler = handlers.get(job.type);

    if (!handler) {
      // An unknown type is a deployment mistake, not a transient fault, so it
      // is failed outright rather than retried forever.
      await prisma.backgroundJob
        .update({
          where: { id: job.id },
          data: { status: "failed", lastError: `No handler registered for type "${job.type}"` },
        })
        .catch(() => {});
      Logger.error(`[JobQueue] No handler for job type "${job.type}" (job ${job.id})`);
      continue;
    }

    try {
      // Shaped like a BullMQ job so existing processors (e.g.
      // workers/payoutProcessor.js) need no changes.
      await handler({ id: job.id, data: job.payload });
      await prisma.backgroundJob.update({
        where: { id: job.id },
        data: { status: "completed", attempts: job.attempts + 1 },
      });
      Logger.debug(`[JobQueue] ${job.type} job ${job.id} completed`);
    } catch (error) {
      await recordFailure(job, error).catch((updateError) => {
        // If we cannot even record the failure the job stays 'processing' and
        // would be stranded; reclaimStuckJobs below is the safety net.
        Logger.error(
          `[JobQueue] Could not record failure for job ${job.id}: ${updateError.message}`
        );
      });
    }
  }

  return jobs.length;
};

/**
 * Returns jobs stuck in 'processing' to the pending pool.
 *
 * A job is only ever left in 'processing' if the process died mid-handler (a
 * deploy, an OOM, a Cloud Run instance being reclaimed). This is the equivalent
 * of BullMQ's stalled-job check, and the reason handlers must be idempotent --
 * which the payout processor already is, by design.
 *
 * @param {number} [olderThanMs=600000] - Grace period before reclaiming.
 * @returns {Promise<number>} Number of jobs reclaimed.
 */
export const reclaimStuckJobs = async (olderThanMs = 10 * 60 * 1000) => {
  try {
    const cutoff = new Date(Date.now() - olderThanMs);
    const { count } = await prisma.backgroundJob.updateMany({
      where: { status: "processing", updatedAt: { lt: cutoff } },
      data: { status: "pending" },
    });
    if (count > 0) {
      Logger.warn(`[JobQueue] Reclaimed ${count} stuck job(s) from 'processing'`);
    }
    return count;
  } catch (error) {
    Logger.error(`[JobQueue] Failed to reclaim stuck jobs: ${error.message}`);
    return 0;
  }
};

/**
 * Deletes completed jobs past a retention window, so the table does not grow
 * without bound. Failed jobs are KEPT: they are the record an operator needs.
 * @param {number} [olderThanMs=604800000] - Retention for completed jobs (7 days).
 * @returns {Promise<number>} Number of rows deleted.
 */
export const pruneCompletedJobs = async (olderThanMs = 7 * 24 * 60 * 60 * 1000) => {
  try {
    const cutoff = new Date(Date.now() - olderThanMs);
    const { count } = await prisma.backgroundJob.deleteMany({
      where: { status: "completed", updatedAt: { lt: cutoff } },
    });
    if (count > 0) {
      Logger.info(`[JobQueue] Pruned ${count} completed job(s)`);
    }
    return count;
  } catch (error) {
    Logger.error(`[JobQueue] Failed to prune completed jobs: ${error.message}`);
    return 0;
  }
};
