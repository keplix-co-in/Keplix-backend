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
