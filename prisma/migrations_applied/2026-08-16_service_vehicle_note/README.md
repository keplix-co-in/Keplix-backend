# 2026-08-16 — Service.vehicle_note

Status: applied.

```
npx prisma db execute --file prisma/migrations_applied/2026-08-16_service_vehicle_note/001_service_vehicle_note.sql
npx prisma generate
```

## Why

The vendor Add Service form gained a "Car name" field for the vendor's own reference (e.g. "Swift,
i20, Baleno") alongside the new Vehicle Segment picker introduced in
`2026-08-16_vehicle_segments`. It has nowhere to live: segment PRICING already has a home
(`ServiceSegmentPrice`), but this note is purely descriptive and per-service, not per-segment.

## What it does

One nullable column, `Service.vehicle_note`. No backfill required for the 23 existing services.

## Safety

`ADD COLUMN IF NOT EXISTS`, nullable, no default that touches existing rows. Idempotent.

## Verification

```sql
SELECT column_name FROM information_schema.columns WHERE table_name = 'Service' AND column_name = 'vehicle_note';
-- 1 row
```
