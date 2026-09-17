# Notification.type + Notification.data

Adds two nullable columns and a composite index to `Notification`.

- `type`  TEXT  — notification kind (`BOOKING_ACCEPTED`, `PAYMENT_RECEIVED`, ...)
- `data`  JSONB — tap-to-navigate payload (`{ "bookingId": 123 }`)
- index `("userId", "createdAt")` for the newest-first list query

Both columns are nullable, so this is backward compatible: rows written before
it simply have `NULL`, and the apps fall back to their previous behaviour for
those.

## Status: NOT YET APPLIED to any database.

> **Update (audit #45/#138-142):** since 2026-09-14 the deploy workflow (`.github/workflows/deploy.yml`) runs `prisma db push` against `schema.prisma` before every deploy to `main`, so schema changes reach production automatically now -- this file's columns are already in `schema.prisma`. The manual steps below predate that gate and are kept only as a historical record of how this change was applied the first time.


Apply with:

    psql "$DATABASE_URL" -f 01_add_type_data.sql

Safe to re-run (`IF NOT EXISTS` throughout).
