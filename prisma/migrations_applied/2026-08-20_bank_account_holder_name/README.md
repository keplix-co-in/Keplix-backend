# VendorProfile.bank_account_holder_name — 2026-08-20

**Status: NOT YET APPLIED to production.**

## What

One nullable column on `VendorProfile`:

```sql
ALTER TABLE "VendorProfile" ADD COLUMN IF NOT EXISTS "bank_account_holder_name" TEXT;
```

## Why

`util/payoutHelper.js` builds the RazorpayX fund account from the vendor's bank
details and has to supply `bank_account.name` — the **account holder's** name.
There was no column holding it, so both `setupVendorPayoutAccount` and
`updateVendorPayoutAccount` sent `business_name` instead.

That is wrong whenever the account is held personally (a sole proprietor's own
name) rather than in the trading name, which is the common case for the small
detailing shops on the platform. RazorpayX validates the payee name against the
account, so the payout is rejected or, worse, routed against a mismatched name.

The vendor app now captures "name in the bank" as its own field; this column
stores it. `payoutHelper` prefers it and falls back to `business_name`, so every
vendor onboarded before this migration keeps behaving exactly as before.

## Safety

Additive, nullable, no backfill, no existing table touched, `IF NOT EXISTS` so
re-running is a no-op. Safe to apply to a live database ahead of the deploy.

## How to apply

```bash
npx prisma db execute --file prisma/migrations_applied/2026-08-20_bank_account_holder_name/001_bank_account_holder_name.sql --schema prisma/schema.prisma
```

Verify:

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'VendorProfile' AND column_name = 'bank_account_holder_name';
-- must return one row
```

Note: `.github/workflows/deploy.yml` runs no Prisma step, so this will not be
applied by deploying — it must be run by hand against each environment's
`DATABASE_URL` (production **and** preview), as with every migration here.
