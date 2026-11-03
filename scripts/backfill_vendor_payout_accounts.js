/**
 * One-off backfill: create RazorpayX payout accounts for vendors who saved
 * bank/UPI details while payout setup was broken.
 *
 * Until 2026-11-03, util/payoutHelper.js called SDK methods that don't exist
 * (razorpayX.contacts / fund_accounts / payouts), so every vendor who saved
 * bank details got a profile but no VendorPayoutAccount row -- and therefore
 * could never be paid (prod logs: vendors 442, 948). Fixing the helper stops
 * new vendors going wrong; it cannot rescue the vendors already missing a
 * payout account, which is what this does.
 *
 * Only touches vendors that have bank (account number + IFSC) or UPI details
 * AND no payout account. Creating a RazorpayX contact/fund account moves no
 * money.
 *
 * Usage (needs the production DATABASE_URL and RazorpayX keys in env):
 *   node scripts/backfill_vendor_payout_accounts.js          # dry run, prints only
 *   node scripts/backfill_vendor_payout_accounts.js --apply  # actually creates them
 */
import prisma from '../util/prisma.js';
import { setupVendorPayoutAccount } from '../util/payoutHelper.js';

const apply = process.argv.includes('--apply');

const run = async () => {
  const existing = await prisma.vendorPayoutAccount.findMany({ select: { vendorId: true } });
  const hasAccount = new Set(existing.map((a) => a.vendorId));

  const profiles = await prisma.vendorProfile.findMany({
    where: {
      OR: [
        // not: "" as well -- the apps save blank strings for untouched fields,
        // and a blank account would just fail at RazorpayX.
        { AND: [{ bank_account_number: { not: null } }, { bank_account_number: { not: "" } }, { ifsc_code: { not: null } }, { ifsc_code: { not: "" } }] },
        { AND: [{ upi_id: { not: null } }, { upi_id: { not: "" } }] },
      ],
    },
  });

  const missing = profiles.filter((p) => !hasAccount.has(p.userId));
  if (missing.length === 0) {
    console.log('Every vendor with bank/UPI details already has a payout account.');
    return;
  }

  // Never print bank account numbers or UPI ids -- only which kind is on file.
  console.log(`${missing.length} vendor(s) have payout details but no payout account:`);
  for (const p of missing) {
    const kind = p.bank_account_number && p.ifsc_code ? 'bank' : 'upi';
    console.log(`  vendor ${p.userId} (${kind})`);
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to create them.');
    return;
  }

  let ok = 0;
  for (const p of missing) {
    try {
      await setupVendorPayoutAccount(p.userId, p);
      ok += 1;
      console.log(`  vendor ${p.userId}: created`);
    } catch (err) {
      console.log(`  vendor ${p.userId}: FAILED - ${err.message}`);
    }
  }
  console.log(`\nDone: ${ok}/${missing.length} created.`);
};

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
