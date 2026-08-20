-- Add VendorProfile.bank_account_holder_name — 2026-08-20
--
-- Column DDL generated with:
--   npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- (line: "bank_account_holder_name" TEXT), then narrowed to an ALTER and made
-- idempotent with IF NOT EXISTS.
--
-- Nullable and additive: no backfill, safe against a live database, re-runnable.

ALTER TABLE "VendorProfile" ADD COLUMN IF NOT EXISTS "bank_account_holder_name" TEXT;
