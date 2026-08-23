# BookingEarlyStart — 2026-08-21

**Status: NOT YET APPLIED to production.**

## What

One new table. Nothing existing is altered:

```sql
CREATE TABLE IF NOT EXISTS "BookingEarlyStart" (...);
```

## Why

The vendor app can now ask a customer "can we start your job earlier?", and the
customer accepts or declines from their app
(`POST /service_api/vendor/:vendorId/bookings/:id/early-start` and
`POST /service_api/user/:userId/bookings/:id/early-start/respond`).

The request has to survive between those two calls — the customer may respond
minutes or hours later — so it needs a row. There was nowhere to put it:
`Booking` has no such column, and `Booking` is the payment/escrow-critical model
that the schema comments explicitly keep unmodified (see `BookingVehicle`). The
FK therefore lives on this table; the `earlyStart` field on `Booking` is a
virtual back-relation and generates no SQL against `Booking`.

`bookingId` is unique, so a re-request replaces the previous offer rather than
leaving the customer able to accept a stale one.

## Safety

Additive, new table only, no backfill, `IF NOT EXISTS` everywhere (the FK is
wrapped in a `DO $$ ... EXCEPTION WHEN duplicate_object` block, since
`ADD CONSTRAINT` has no `IF NOT EXISTS` in Postgres). Safe to apply to a live
database ahead of the deploy.

## How to apply

```bash
npx prisma db execute --file prisma/migrations_applied/2026-08-21_booking_early_start/001_booking_early_start.sql --schema prisma/schema.prisma
```

Verify:

```sql
SELECT table_name FROM information_schema.tables WHERE table_name = 'BookingEarlyStart';
-- must return one row
```

Note: `.github/workflows/deploy.yml` runs no Prisma step, so this will not be
applied by deploying — it must be run by hand against each environment's
`DATABASE_URL` (production **and** preview), as with every migration here.

Run `npx prisma generate` after pulling this change, or `prisma.bookingEarlyStart`
is undefined at runtime.
