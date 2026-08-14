# Walk-in jobs, vehicles, health sheets — applied 2026-08-13

Applied via `prisma db execute` against the pooled connection (`DATABASE_URL`,
pgbouncer transaction pooling), in order: `001_schema.sql`, then
`002_check_constraints.sql`, then `003_seed_health_components.sql`. All three
reported "Script executed successfully."

Post-apply verification (see task #82 in this session):

- `Booking` count 37, `Payment` count 23, `PayoutSettlement` count 0 —
  unchanged from before the migration; no existing table was altered except
  the additive, defaulted `PlatformSettings.isHealthSheetRequired` /
  `healthSheetRequiredFrom` columns.
- `HealthComponent` seeded with exactly the 5 rows from the product spec.
- The `healthsheet_one_parent` CHECK correctly rejects a `HealthSheet` row
  with both `bookingId`/`walkInJobId` set, and one with neither set.
- The `healthsheetitem_max_2_photos` CHECK correctly rejects 3 photos on a
  `HealthSheetItem` and allows 2. All test inserts ran inside
  `prisma.$transaction` blocks that intentionally threw at the end, so
  nothing written during testing was persisted — confirmed by re-counting
  `HealthSheet`/`HealthSheetItem` (0/0) and `HealthComponent` (5) afterward.

**Known gap found during verification, not caused by this migration:**
`PlatformSettings` has **no row** in production. Any code reading
`isHealthSheetRequired`/`healthSheetRequiredFrom` must handle a missing row
by treating the gate as disabled (`false`), not by assuming a singleton
exists.

**Not yet done:** the schema was applied over the pgbouncer-pooled connection,
not a direct one, per an explicit choice made in this session (no direct URL
was available at the time). It completed without error, but if a future
migration in this project needs multi-statement DDL that pgbouncer's
transaction-pooling mode is more likely to choke on, get the direct
connection string first.
