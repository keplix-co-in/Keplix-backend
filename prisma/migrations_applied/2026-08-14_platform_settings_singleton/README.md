# PlatformSettings singleton + mandatory-inspection gate — applied 2026-08-14

**Status: APPLIED to production** (via Prisma client, not SQL — it is a single
data row, not DDL).

## Why

`PlatformSettings` is modelled as a singleton but had **no row at all** — the gap
flagged as a known issue in `2026-08-13_walk_in_health_sheet_vehicle/README.md`.
Every reader fell through to the `DEFAULTS` in `util/platformSettings.js`, which
meant `isHealthSheetRequired` was permanently `false` and the mandatory-inspection
gate could never fire, on bookings or walk-ins.

## What was inserted

```
id                      7
isPlatformFeeEnabled    true
platformFeePercentage   0.1
isHealthSheetRequired   true
healthSheetRequiredFrom 2026-08-14T13:50:15.379Z
updatedAt               2026-08-14T13:50:15.379Z
```

`isPlatformFeeEnabled` / `platformFeePercentage` were set to **exactly** the values
`DEFAULTS` already returned, so the row now existing changes nothing about platform
fee behaviour. The only behavioural change is the inspection gate.

## Rollout safety

`healthSheetRequiredFrom` is anchored to the moment of insert, not left null.
`isHealthSheetRequiredFor(createdAt)` returns `true` for *every* job when that
column is null — which would have retroactively gated every booking and walk-in
already in flight, including ones whose garage never had a way to submit an
inspection. Anchoring means only jobs created from this timestamp onward are gated.

Verified immediately after insert:

- a job created 2026-01-01 → **not** gated
- a job created after the anchor → gated
- exactly 1 row in `PlatformSettings`

## Consequence to be aware of

Completing a Booking or WalkInJob created from this timestamp onward now returns
**409 `HEALTH_SHEET_REQUIRED`** until a health sheet exists for it. Both client
flows handle this:

- Bookings: "Mark Done" already routed through `VehicleInspection` first.
- Walk-ins: "Inspect & close" routes through `VehicleInspection` first, and the
  close request retries automatically afterwards.

## To roll back

```sql
UPDATE "PlatformSettings" SET "isHealthSheetRequired" = false;
```

Prefer this over deleting the row — the row itself is correct and should exist.
