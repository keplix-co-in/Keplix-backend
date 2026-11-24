// One-off, idempotent: create the missing trial VendorSubscription row for
// approved vendors. Owner decision 2026-11-24: every old vendor gets a fresh
// trial starting TODAY (not their sign-up date, which would hide most of them
// as already expired). Dry-run by default; pass --apply to write.
//   node scripts/backfillVendorTrials.js           (dry run)
//   node scripts/backfillVendorTrials.js --apply
import prisma from '../util/prisma.js';
import { getOrCreateSubscription } from '../util/subscription.js';

const apply = process.argv.includes('--apply');

const vendors = await prisma.user.findMany({
  where: { role: 'vendor', vendorProfile: { is: { status: 'approved' } }, vendorSubscription: { is: null } },
  select: { id: true, createdAt: true },
});
console.log(`${vendors.length} approved vendor(s) without a subscription row. ${apply ? 'APPLYING' : 'DRY RUN (use --apply)'}`);
for (const v of vendors) {
  const startsAt = new Date(); // owner: trial starts now for old vendors
  console.log(`vendor ${v.id}: trial starts ${startsAt.toISOString()}`);
  if (apply) await getOrCreateSubscription(v.id, startsAt); // idempotent: returns existing row if any
}
await prisma.$disconnect();
