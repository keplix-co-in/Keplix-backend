-- Free-text vendor note on which cars a service's segment pricing was set up
-- for. Purely descriptive, not used for matching or pricing (that's
-- ServiceSegmentPrice.segment) — a nullable addition, no backfill needed.
ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "vehicle_note" TEXT;
