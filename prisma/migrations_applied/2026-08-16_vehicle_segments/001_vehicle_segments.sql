-- Adds vehicle segments (hatchback/sedan/compact_suv/muv/luxury), per-segment
-- service pricing, and a BookingVehicle side table linking a booking to the car
-- and the price it was charged. Also adds a nullable HealthComponent.category
-- column (groundwork only, unused by any query yet).
--
-- Booking itself is NOT modified — see the README.

-- 1. The segment enum.
DO $$ BEGIN
  CREATE TYPE "VehicleSegment" AS ENUM ('HATCHBACK', 'SEDAN', 'COMPACT_SUV', 'MUV', 'LUXURY');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2. New nullable columns on Vehicle. Nullable so every existing row (4 today)
--    stays valid with no backfill.
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "segment" "VehicleSegment";
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "car_name" TEXT;
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "is_primary" BOOLEAN NOT NULL DEFAULT false;

-- 3. Per-segment pricing. Additive: a service with no rows here still prices
--    off Service.price exactly as before.
CREATE TABLE IF NOT EXISTS "ServiceSegmentPrice" (
  "id"        SERIAL PRIMARY KEY,
  "serviceId" INTEGER NOT NULL,
  "segment"   "VehicleSegment" NOT NULL,
  "price"     DECIMAL(10, 2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ServiceSegmentPrice_serviceId_fkey"
    FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ServiceSegmentPrice_serviceId_segment_key"
  ON "ServiceSegmentPrice"("serviceId", "segment");
CREATE INDEX IF NOT EXISTS "ServiceSegmentPrice_serviceId_idx"
  ON "ServiceSegmentPrice"("serviceId");

-- 4. Booking → vehicle link + price snapshot. Holds the FK to Booking (not the
--    other way round), same pattern as HealthSheet, so Booking needs no DDL.
CREATE TABLE IF NOT EXISTS "BookingVehicle" (
  "id"             SERIAL PRIMARY KEY,
  "bookingId"      INTEGER NOT NULL,
  "vehicleId"      INTEGER,
  "segment"        "VehicleSegment",
  "price_snapshot" DECIMAL(10, 2) NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BookingVehicle_bookingId_key" UNIQUE ("bookingId"),
  CONSTRAINT "BookingVehicle_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE,
  CONSTRAINT "BookingVehicle_vehicleId_fkey"
    FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "BookingVehicle_vehicleId_idx" ON "BookingVehicle"("vehicleId");

-- 5. Category-adaptive health sheets: groundwork only. Nullable, unread by any
--    controller today — the checklist stays exactly as it is until rendering
--    work deliberately reads this column.
ALTER TABLE "HealthComponent" ADD COLUMN IF NOT EXISTS "category" TEXT;
