-- Prisma cannot express these, so they are applied as a separate script
-- (running 001 through `migrate diff` again would otherwise report drift
-- against constraints it doesn't know about). See schema.prisma comments on
-- HealthSheet and HealthSheetItem for why these exist.

-- Exactly one of bookingId / walkInJobId must be set — a health sheet
-- attaches to a Booking or a WalkInJob, never both, never neither.
ALTER TABLE "HealthSheet" ADD CONSTRAINT "healthsheet_one_parent"
  CHECK (("bookingId" IS NOT NULL AND "walkInJobId" IS NULL)
      OR ("bookingId" IS NULL AND "walkInJobId" IS NOT NULL));

-- At most 2 photos per inspection item, per the product spec.
ALTER TABLE "HealthSheetItem" ADD CONSTRAINT "healthsheetitem_max_2_photos"
  CHECK (array_length(photos, 1) IS NULL OR array_length(photos, 1) <= 2);
