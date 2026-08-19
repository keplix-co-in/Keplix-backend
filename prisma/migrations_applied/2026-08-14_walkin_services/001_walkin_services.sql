-- Walk-in selected services, and health-sheet items that can be a service
-- instead of a fixed inspection component.
--
-- Additive and idempotent. The two ALTER COLUMN ... DROP NOT NULL calls widen
-- existing columns, which cannot fail against existing rows.

-- 1. Services chosen when a walk-in customer is checked in.
--    name/price are snapshots so re-pricing or deleting a catalogue service
--    never rewrites what a past job records.
CREATE TABLE IF NOT EXISTS "WalkInJobService" (
  "id"          SERIAL PRIMARY KEY,
  "walkInJobId" INTEGER NOT NULL,
  "serviceId"   INTEGER,
  "name"        TEXT    NOT NULL,
  "price"       DECIMAL(10,2),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WalkInJobService_walkInJobId_fkey"
    FOREIGN KEY ("walkInJobId") REFERENCES "WalkInJob"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WalkInJobService_serviceId_fkey"
    FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "WalkInJobService_walkInJobId_idx"
  ON "WalkInJobService" ("walkInJobId");

-- 2. HealthSheetItem can now describe a service.
--
--    componentId becomes nullable: an item is EITHER a component (booking
--    path, unchanged) OR a walk-in service.
--    status becomes nullable: "skip" still writes the sheet — so the
--    mandatory-inspection gate can never strand a job — but leaves per-item
--    detail blank.
--    label denormalises the display name so every reader has one field to read
--    rather than branching on which foreign key is set.
ALTER TABLE "HealthSheetItem" ALTER COLUMN "componentId" DROP NOT NULL;
ALTER TABLE "HealthSheetItem" ALTER COLUMN "status"      DROP NOT NULL;

ALTER TABLE "HealthSheetItem" ADD COLUMN IF NOT EXISTS "walkInJobServiceId" INTEGER;
ALTER TABLE "HealthSheetItem" ADD COLUMN IF NOT EXISTS "label" TEXT;
ALTER TABLE "HealthSheetItem" ADD COLUMN IF NOT EXISTS "price" DECIMAL(10,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'HealthSheetItem_walkInJobServiceId_fkey'
  ) THEN
    ALTER TABLE "HealthSheetItem"
      ADD CONSTRAINT "HealthSheetItem_walkInJobServiceId_fkey"
      FOREIGN KEY ("walkInJobServiceId") REFERENCES "WalkInJobService"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Postgres allows repeated NULLs in a unique index, so component rows and
-- service rows coexist without colliding on either constraint.
CREATE UNIQUE INDEX IF NOT EXISTS "HealthSheetItem_healthSheetId_walkInJobServiceId_key"
  ON "HealthSheetItem" ("healthSheetId", "walkInJobServiceId");

-- 3. Backfill label for any pre-existing component rows, so readers can rely on
--    it uniformly. (Expected to affect 0 rows — HealthSheet is empty today.)
UPDATE "HealthSheetItem" i
SET "label" = c."label"
FROM "HealthComponent" c
WHERE i."componentId" = c."id" AND i."label" IS NULL;
