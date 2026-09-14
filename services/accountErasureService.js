import prisma from "../util/prisma.js";
import Logger from "../util/logger.js";
import { destroyAsset, publicIdFromUrl } from "../util/cloudinary.js";

/**
 * eraseUserPii
 *
 * GDPR Art.17 erasure for a single account. Deactivates the account
 * (matches the existing admin deleteUser pattern for accounts with booking
 * history -- Booking.user is onDelete: Restrict, so a hard User.delete is
 * not an option once any booking exists) and redacts personal fields
 * across every table that stores them outside the User/UserProfile row
 * itself, per the 2026-09-12 audit's PII inventory (F11/F19/F22).
 *
 * Deliberately NOT touched, per GDPR Art.17(3)(b) (compliance with a legal
 * obligation -- financial/tax record-keeping):
 *   - Booking, Payment, Refund, PayoutSettlement rows are kept as-is. They
 *     reference userId but carry no embedded name/phone/email of their own
 *     to redact.
 *   - Review.comment / Message.message_text (free-text content) are left
 *     alone -- these are the OTHER party's record of an interaction, not
 *     solely this user's data, and redacting message history the user sent
 *     to a vendor is a separate policy decision from erasing their own
 *     profile/contact fields.
 *
 * NOT part of this pass (tracked separately, see the audit's F27/F50):
 *   - Unclaimed WalkInJob rows matched only by phone number, not
 *     claimedByUserId. Only rows this specific account has actually
 *     claimed are redacted here.
 *   - A general per-model retention cron (Message/Notification/Document).
 *
 * @param {number} userId
 * @returns {Promise<{
 *   deactivated: boolean,
 *   profileRedacted: boolean,
 *   phoneIdentityRemoved: boolean,
 *   vehiclesRedacted: number,
 *   walkInJobsRedacted: number,
 *   assetsDeleted: number,
 * }>}
 */
export const eraseUserPii = async (userId) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { userProfile: true },
  });

  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  // Delete the actual Cloudinary assets BEFORE nulling the DB columns that
  // point at them -- once the column is null, the URL (and therefore the
  // public_id needed to delete it) is gone for good. Best-effort: a failed
  // Cloudinary delete must not block the rest of erasure, since the DB
  // reference is removed regardless (see destroyAsset's own doc).
  const assetUrls = [
    user.userProfile?.profile_picture,
    user.userProfile?.id_proof_front,
    user.userProfile?.id_proof_back,
  ].filter(Boolean);

  let assetsDeleted = 0;
  for (const url of assetUrls) {
    const ok = await destroyAsset(publicIdFromUrl(url));
    if (ok) assetsDeleted += 1;
  }

  let profileRedacted = false;
  if (user.userProfile) {
    await prisma.userProfile.update({
      where: { userId },
      data: {
        name: "Deleted User",
        phone: null,
        address: null,
        id_proof_front: null,
        id_proof_back: null,
        profile_picture: null,
      },
    });
    profileRedacted = true;
  }

  // email is @unique and NOT NULL -- a placeholder that can never collide
  // with a real signup (another deleted-<id> row is a different id) rather
  // than leaving the original address live and searchable.
  await prisma.user.update({
    where: { id: userId },
    data: {
      email: `deleted-${userId}@invalid`,
      fcmToken: null,
      pushToken: null,
      is_active: false,
    },
  });

  // PhoneIdentity.phone_e164 is NOT NULL + @unique, so it cannot be
  // redacted in place without freeing that number for a future signup to
  // collide against oddly -- deleting the row achieves the same erasure
  // outcome (this account is no longer resolvable by phone number).
  const phoneIdentityResult = await prisma.phoneIdentity.deleteMany({
    where: { userId },
  });

  const vehiclesResult = await prisma.vehicle.updateMany({
    where: { ownerUserId: userId },
    data: { owner_phone: null, owner_name: null },
  });

  // customer_phone is NOT NULL (no `?`), unlike owner_phone above -- a
  // literal placeholder rather than null, since nothing downstream expects
  // this column to ever be absent.
  const walkInJobsResult = await prisma.walkInJob.updateMany({
    where: { claimedByUserId: userId },
    data: { customer_name: "Deleted Customer", customer_phone: "0000000000" },
  });

  Logger.info(
    `[Erasure] User ${userId}: profile=${profileRedacted}, phoneIdentity=${phoneIdentityResult.count}, ` +
    `vehicles=${vehiclesResult.count}, walkInJobs=${walkInJobsResult.count}, assets=${assetsDeleted}`
  );

  return {
    deactivated: true,
    profileRedacted,
    phoneIdentityRemoved: phoneIdentityResult.count > 0,
    vehiclesRedacted: vehiclesResult.count,
    walkInJobsRedacted: walkInJobsResult.count,
    assetsDeleted,
  };
};
