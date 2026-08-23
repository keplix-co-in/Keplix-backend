# Notification.type + Notification.data

Adds two nullable columns and a composite index to `Notification`.

- `type`  TEXT  — notification kind (`BOOKING_ACCEPTED`, `PAYMENT_RECEIVED`, ...)
- `data`  JSONB — tap-to-navigate payload (`{ "bookingId": 123 }`)
- index `("userId", "createdAt")` for the newest-first list query

Both columns are nullable, so this is backward compatible: rows written before
it simply have `NULL`, and the apps fall back to their previous behaviour for
those.

## Status: NOT YET APPLIED to any database.

Apply with:

    psql "$DATABASE_URL" -f 01_add_type_data.sql

Safe to re-run (`IF NOT EXISTS` throughout).
