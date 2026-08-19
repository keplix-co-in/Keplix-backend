# Walk-in selected services + service-capable health sheet items — 2026-08-14

**Status: APPLIED to production 2026-08-14.** All verification queries below were run
immediately afterwards and passed: table created, `componentId`/`status` both nullable, the
three new columns present, both unique indexes present, and 0 component rows left without a
label. Command used:

    npx prisma db execute --file prisma/migrations_applied/2026-08-14_walkin_services/001_walkin_services.sql --schema prisma/schema.prisma

## Why

`WalkInJob` had **no relation to `Service` at all** — the work done was recorded only as
free-text `description`. So there was nothing to drive per-service inspection cards or a bill
from. And `HealthSheetItem.componentId` was a non-nullable FK to `HealthComponent`, which meant
an item could only ever be one of the five fixed inspection points.

## What it does

1. Creates `WalkInJobService` — the services picked at check-in. `serviceId` is nullable for a
   one-off custom entry; `name`/`price` are **snapshots** so re-pricing or deleting a catalogue
   service never rewrites history. Deleting the service sets the FK null rather than removing
   the row.
2. `HealthSheetItem.componentId` → nullable, plus new `walkInJobServiceId`, `label`, `price`.
   An item is now **either** a component (booking path) **or** a walk-in service.
3. `HealthSheetItem.status` → nullable. "Skip" still writes a sheet so the mandatory-inspection
   gate can never strand a job, but leaves the per-item detail blank.
4. Adds `@@unique(healthSheetId, walkInJobServiceId)` alongside the existing component unique.
   Postgres permits repeated NULLs in a unique index, so the two kinds of row coexist.
5. Backfills `label` on existing component rows.

## Safety

Every statement is additive or widening (`DROP NOT NULL` cannot fail against existing data),
and all are guarded with `IF NOT EXISTS` / `IF NOT EXISTS`-style checks, so re-running is safe.

`HealthSheet` and `HealthSheetItem` are **empty in production**, so step 5 affects 0 rows and
no existing sheet can be corrupted by the nullability changes.

## Verification

    -- new table + index
    SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'WalkInJobService';   -- 1

    -- both columns now nullable
    SELECT column_name, is_nullable FROM information_schema.columns
    WHERE table_name = 'HealthSheetItem' AND column_name IN ('componentId','status');       -- YES, YES

    -- new columns present
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'HealthSheetItem' AND column_name IN ('walkInJobServiceId','label','price');

    -- both unique indexes present
    SELECT indexname FROM pg_indexes WHERE tablename = 'HealthSheetItem';

    -- no component row left without a label
    SELECT COUNT(*) FROM "HealthSheetItem" WHERE "componentId" IS NOT NULL AND "label" IS NULL;  -- 0

## Note on the existing CHECK constraints

`healthsheetitem_max_2_photos` from the 2026-08-13 migration still applies and is unaffected.
There is deliberately **no** DB-level XOR constraint forcing exactly one of
`componentId`/`walkInJobServiceId` — the controller enforces it, and adding one would have to
tolerate the "skip" rows. Worth revisiting if a third item kind ever appears.
