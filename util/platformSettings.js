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
