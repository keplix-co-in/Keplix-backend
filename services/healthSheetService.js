import prisma from '../util/prisma.js';
import { isHealthSheetRequiredFor } from '../util/platformSettings.js';

/**
 * Single source of truth for "does this job need a health sheet before it
 * can be completed", called from both booking completion
 * (controllers/vendor/bookingController.js) and walk-in job completion
 * (controllers/vendor/walkInJobController.js) so the rule can never drift
 * between the two.
 */
export async function assertHealthSheetPresent({ createdAt, bookingId, walkInJobId }) {
  const required = await isHealthSheetRequiredFor(createdAt);
  if (!required) return { ok: true };

  const sheet = await prisma.healthSheet.findFirst({
    where: bookingId ? { bookingId } : { walkInJobId },
    select: { id: true },
  });

  if (sheet) return { ok: true };

  return {
    ok: false,
    code: 'HEALTH_SHEET_REQUIRED',
    message: 'Submit the vehicle health sheet before completing this job.',
  };
}
