import prisma from './prisma.js';

/**
 * PlatformSettings is modelled as a singleton but has no row in production
 * today (confirmed empty during the walk-in/health-sheet migration). Every
 * reader must treat a missing row as "nothing enabled" rather than throwing
 * or assuming a row exists — this is the one place that decision is made.
 */
const DEFAULTS = {
  isPlatformFeeEnabled: true,
  platformFeePercentage: 0.1,
  isHealthSheetRequired: false,
  healthSheetRequiredFrom: null,
  // Refund / escrow policy. autoRefundOnCancellation defaults false for the
  // same reason as isHealthSheetRequired: a missing settings row must never
  // silently switch on something that moves money.
  payoutHoldHours: 24,
  autoRefundOnCancellation: false,
  refundGatewayFeeBorneBy: 'customer',
};

export async function getPlatformSettings() {
  const row = await prisma.platformSettings.findFirst();
  return row ?? DEFAULTS;
}

/**
 * Whether the mandatory-inspection gate applies to a job created at
 * `createdAt`. Anchored to the job's own creation time, not "now" — flipping
 * the flag must never strand a job that was already in flight before a
 * garage had any way to see the inspection form. See PlatformSettings in
 * schema.prisma and the rollout notes in the walk-in/health-sheet plan.
 */
export async function isHealthSheetRequiredFor(createdAt) {
  const settings = await getPlatformSettings();
  if (!settings.isHealthSheetRequired) return false;
  if (!settings.healthSheetRequiredFrom) return true;
  return createdAt >= settings.healthSheetRequiredFrom;
}

/**
 * The commission rate to apply to a payment being recorded RIGHT NOW.
 *
 * `isPlatformFeeEnabled` and `platformFeePercentage` have existed on
 * PlatformSettings (and in the admin PATCH endpoint) since the settings
 * singleton was added, but nothing ever read them: services/paymentService.js
 * used a local `PLATFORM_FEE_PERCENTAGE = 0.1` constant, so toggling the
 * admin switch changed precisely nothing about the money. This is the reader
 * that makes the switch real.
 *
 * Returns 0 when the fee is switched off, which makes vendorAmount equal the
 * full amount — the customer's total is untouched either way, because the fee
 * is carved OUT of the service price rather than added on top of it (see
 * resolveBookingAmount in util/servicePricing.js).
 *
 * A missing settings row falls back to DEFAULTS (fee ON at 10%), NOT to zero:
 * an absent row must never silently waive the platform's entire revenue. Same
 * principle as getPlatformSettings above, opposite direction — there, a
 * missing row must not silently switch something ON.
 *
 * Callers must resolve this ONCE at payment-record time and persist the
 * result on Payment.platformFee/vendorAmount, never re-derive it later:
 * payoutHelper transfers straight from the stored vendorAmount, so a rate
 * change must not be able to alter money already promised to a vendor. Same
 * reasoning as resolvePayoutHoldUntil below.
 */
export async function resolvePlatformFeeRate() {
  const settings = await getPlatformSettings();
  if (settings.isPlatformFeeEnabled === false) return 0;

  const rate = Number(settings.platformFeePercentage);
  // A corrupt/out-of-range stored value falls back to the default rather than
  // producing a negative fee (which would pay the vendor MORE than collected)
  // or a >100% fee (which would make vendorAmount negative).
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    return DEFAULTS.platformFeePercentage;
  }
  return rate;
}

/**
 * When a payout for a booking completed now becomes releasable.
 *
 * Computed at completion time and stored on Payment.payoutHoldUntil rather
 * than re-derived at payout time, so shortening the window later can't
 * retroactively release money that was promised to be held — and lengthening
 * it can't freeze a payout a vendor was already told was due.
 */
export async function resolvePayoutHoldUntil(completedAt = new Date()) {
  const settings = await getPlatformSettings();
  const hours = Number(settings.payoutHoldHours ?? DEFAULTS.payoutHoldHours);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return new Date(completedAt.getTime() + hours * 60 * 60 * 1000);
}
