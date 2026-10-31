import cron from "node-cron";
import prisma from "../util/prisma.js";
import Logger from "../util/logger.js";
import { destroyAsset, publicIdFromUrl } from "../util/cloudinary.js";

/**
 * Deletes sign-ups that were started and never finished.
 *
 * WHY: googleLogin and verifyEmailOTP create a User (plus a profile with
 * phone "") the moment someone authenticates. registerUser creates a bare User
 * before email verification. If that person then quits and uninstalls, the row
 * stays forever: no phone, never usable, but still stored, backed up and
 * counted. The owner asked (2026-10-31) for these to be removed after 7 days,
 * for customers and vendors alike, without ever touching a real account.
 *
 * "Abandoned" is deliberately narrow. An account is deleted ONLY if ALL hold:
 *   - created more than RETENTION_DAYS ago and not an admin
 *   - no bookings as a customer (Booking.user has no onDelete, so deleting
 *     would fail anyway -- and a booking means a real customer)
 *   - no verified phone (PhoneIdentity), no vehicles, no reviews, no walk-in
 *     jobs claimed
 *   - customer: no profile, or a profile with no phone
 *   - vendor: no profile, or onboarding_completed=false with an empty phone,
 *     AND no services, walk-in jobs or health sheets. Those cascade on User
 *     delete, so a vendor with any of them is never touched.
 * The same filter is applied again inside deleteMany, so someone who finishes
 * their profile between the find and the delete is kept.
 */
export const RETENTION_DAYS = 7;
const BATCH_SIZE = 200;

let task = null;

const emptyPhone = { OR: [{ phone: null }, { phone: "" }] };

/**
 * Pure: the Prisma `where` that selects abandoned accounts created before
 * `cutoff`.
 * @param {Date} cutoff
 */
export const buildAbandonedWhere = (cutoff) => ({
  createdAt: { lt: cutoff },
  role: { in: ["user", "vendor"] },
  bookings: { none: {} },
  phoneIdentity: { is: null },
  vehicles: { none: {} },
  reviews: { none: {} },
  walkInJobs: { none: {} },
  OR: [
    {
      role: "user",
      OR: [{ userProfile: { is: null } }, { userProfile: { is: emptyPhone } }],
    },
    {
      role: "vendor",
      services: { none: {} },
      vendorWalkInJobs: { none: {} },
      healthSheets: { none: {} },
      OR: [
        { vendorProfile: { is: null } },
        // VendorProfile.phone is required (non-null), so "" is the only empty value.
        { vendorProfile: { is: { onboarding_completed: false, phone: "" } } },
      ],
    },
  ],
});

/**
 * Finds and deletes one batch of abandoned accounts, removing their uploaded
 * images from Cloudinary first (best effort; a failed image delete never
 * blocks the row delete).
 *
 * @param {{now?: Date, batchSize?: number}} [opts]
 * @returns {Promise<{candidates: number, deleted: number, assetsFailed: number}>}
 */
export const pruneAbandonedAccounts = async ({ now = new Date(), batchSize = BATCH_SIZE } = {}) => {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const where = buildAbandonedWhere(cutoff);

  const candidates = await prisma.user.findMany({
    where,
    take: batchSize,
    select: {
      id: true,
      userProfile: { select: { profile_picture: true, id_proof_front: true, id_proof_back: true } },
      vendorProfile: { select: { image: true, cover_image: true } },
    },
  });

  if (candidates.length === 0) {
    return { candidates: 0, deleted: 0, assetsFailed: 0 };
  }

  let assetsFailed = 0;
  for (const c of candidates) {
    const urls = [
      c.userProfile?.profile_picture,
      c.userProfile?.id_proof_front,
      c.userProfile?.id_proof_back,
      c.vendorProfile?.image,
      c.vendorProfile?.cover_image,
    ].filter(Boolean);
    for (const url of urls) {
      try {
        const ok = await destroyAsset(publicIdFromUrl(url));
        if (ok === false) assetsFailed += 1;
      } catch {
        assetsFailed += 1;
      }
    }
  }

  const result = await prisma.user.deleteMany({
    where: { id: { in: candidates.map((c) => c.id) }, ...where },
  });

  // Counts only -- no emails or ids in the log.
  Logger.info(
    `[AbandonedCleanup] Deleted ${result.count} of ${candidates.length} abandoned account(s) older than ${RETENTION_DAYS} days` +
      (assetsFailed ? `; ${assetsFailed} image(s) could not be removed from Cloudinary` : "")
  );

  return { candidates: candidates.length, deleted: result.count, assetsFailed };
};

/**
 * Schedules the daily run (03:30 server time). Idempotent.
 * @returns {Promise<void>}
 */
export const scheduleAbandonedAccountCleanup = async () => {
  if (task) return;

  task = cron.schedule("30 3 * * *", async () => {
    try {
      await pruneAbandonedAccounts();
    } catch (error) {
      Logger.error(`[AbandonedCleanup] Daily prune failed: ${error.message}`);
    }
  });

  Logger.info("[AbandonedCleanup] Daily abandoned-account prune scheduled");
};

/** Stops the schedule, for graceful shutdown. */
export const stopAbandonedAccountCleanup = () => {
  if (task) {
    task.stop();
    task = null;
  }
};
