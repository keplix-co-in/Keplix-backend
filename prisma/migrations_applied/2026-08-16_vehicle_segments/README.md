# 2026-08-16 — Vehicle segments, per-segment pricing, BookingVehicle

Status: applied.

```
npx prisma db execute --file prisma/migrations_applied/2026-08-16_vehicle_segments/001_vehicle_segments.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/migrations_applied/2026-08-16_vehicle_segments/002_seed_category_health_components.sql --schema prisma/schema.prisma
npx prisma generate --schema prisma/schema.prisma
```

## Why

A hatchback wash and a Luxury wash are not the same price. There was no concept of a car's size
class anywhere in the schema, so a service could only ever have one price.

Bundled in the same migration: groundwork for the spec's category-adaptive health sheets
(`HealthComponent.category`), since it touches the same table family and is a single nullable
column with no behavioural change.

## What it does

- `VehicleSegment` enum: `HATCHBACK | SEDAN | COMPACT_SUV | MUV | LUXURY`.
- `Vehicle` gains `segment` (nullable), `car_name` (free text, nullable), `is_primary` (default
  `false`). All 4 existing rows are valid with no backfill.
- `ServiceSegmentPrice` — additive per-service, per-segment price. A service with zero rows here
  keeps pricing off `Service.price` exactly as it does today; nothing here forces a backfill of
  the 23 existing services.
- `BookingVehicle` — **holds the FK to `Booking`**, not the reverse. `Booking` is documented in
  `schema.prisma` as the payment/escrow-critical model that must not be modified; this follows the
  same pattern `HealthSheet` already uses. Carries `price_snapshot` so a vendor changing prices
  later can never retroactively change what an already-placed booking charges.
- `HealthComponent.category` — nullable, seeded on the 5 existing rows as `MECHANICAL`, plus 14
  new rows for the other 4 spec categories (Wash, Denting & Painting, Tyres, Insurance). **The 14
  new rows are seeded `is_active = false`.** `healthSheetController.js` requires every *active*
  component on a component-based sheet — turning them on now would silently demand fields (Panel
  Repaired, Tread Depth...) on the existing mechanical inspection form, which has no UI for them.
  They stay inactive and invisible until the category-adaptive rendering work turns each set on
  together with the code that reads this column.

## Safety

Every statement is additive and idempotent: `IF NOT EXISTS` / `DO $$ ... EXCEPTION` guards on the
enum and columns, `ON CONFLICT DO NOTHING` on the seed. Re-running either file is a no-op. No
existing column is altered or dropped; `Booking` receives no DDL at all.

## Verification

Before (see `_before.mjs` run in-session): `VehicleSegment` enum: 0 rows. `Vehicle` new columns:
none. `ServiceSegmentPrice` / `BookingVehicle`: did not exist. `HealthComponent.category`: did not
exist. `Booking` columns: `id,userId,serviceId,booking_date,booking_time,status,notes,createdAt,
updatedAt,vendor_status,completion_images`. Row counts: 4 vehicles, 23 services, 38 bookings, 5
health components.

After, confirm:

```sql
SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'VehicleSegment';
-- 5 rows: HATCHBACK, SEDAN, COMPACT_SUV, MUV, LUXURY

SELECT column_name FROM information_schema.columns WHERE table_name = 'Vehicle'
  AND column_name IN ('segment','car_name','is_primary');
-- 3 rows

SELECT table_name FROM information_schema.tables
  WHERE table_name IN ('ServiceSegmentPrice','BookingVehicle');
-- 2 rows

SELECT category, is_active, count(*) FROM "HealthComponent" GROUP BY category, is_active ORDER BY 1;
-- MECHANICAL | true  | 5
-- DENTING_PAINTING | false | 3
-- INSURANCE | false | 4
-- TYRES | false | 3
-- WASH | false | 4

-- Booking untouched:
SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns
  WHERE table_name = 'Booking';
-- unchanged from before: id,userId,serviceId,booking_date,booking_time,status,notes,createdAt,
--   updatedAt,vendor_status,completion_images

-- Row counts unchanged (still 4 vehicles / 23 services / 38 bookings):
SELECT (SELECT COUNT(*) FROM "Vehicle")::int, (SELECT COUNT(*) FROM "Service")::int,
       (SELECT COUNT(*) FROM "Booking")::int;
```
