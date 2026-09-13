# Cutting over from `db push` to `prisma migrate deploy`

Generated 2026-09-13 as part of the audit remediation (Level 2, rank #1: "`db push`
with no migration history is the only route schema changes take to production").

## What's already done (safe, no database was touched)

`prisma/migrations/20260913000000_baseline/migration.sql` was generated with:

```
npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
```

This is a **read-only** Prisma command (confirmed via `prisma migrate diff --help`:
*"prisma migrate diff is a read-only command that does not write to your
datasource(s)"*) — it diffed an empty schema against `schema.prisma` as two local
files. No database was connected to, read from, or written to. `prisma/migrations/migration_lock.toml` was also added (`provider = "postgresql"`), which
Prisma Migrate requires.

The migration is 984 lines of `CREATE TABLE`/`CREATE TYPE` statements representing
the **entire current `schema.prisma`** as one baseline.

## ⚠️ Why you cannot just run `prisma migrate resolve --applied` yet

While preparing this, I found that `TODO.md` documents **at least two real,
currently-unresolved gaps between `schema.prisma` and what's actually live in
production**:

- `TODO.md:653` — *"Migration `2026-08-22_notification_type_data` NOT applied —
  `type`/`data` writes will fail until it runs."*
- `TODO.md:781` — *"`bank_account_holder_name` + migration (applied to dev DB;
  **not** production)"*

`schema.prisma` already includes both of these columns. The baseline migration
above was generated from `schema.prisma`, so it **includes them too** — meaning if
you tell Prisma "this baseline is already applied" while production is still
missing these columns, Prisma will believe they exist when they don't. No future
`prisma migrate deploy` would ever add them, since Prisma's migration history would
say that state was already reached. The actual production bug (`type`/`data`
writes failing) would then become **permanently invisible** to the migration
tooling — worse than the current situation, not better.

**Do not run the resolve step until production and `schema.prisma` are confirmed
to match.**

## The correct cutover sequence

1. **Let one more regular deploy run exactly as it does today.** `deploy.yml`'s
   `db push` step (`.github/workflows/deploy.yml`, "Apply database schema") is
   left completely unchanged by this work. The next normal deploy will run
   `prisma db push` against `MIGRATION_DATABASE_URL` as always, which — because
   `db push` reconciles the live database to match `schema.prisma` — will apply
   the two pending columns above (and anything else currently drifted) for real.
   This is not a new risk: it's the exact same step this repo already runs on
   every deploy today.

2. **Confirm that deploy succeeded** and that production actually has the new
   columns. A quick way to check without touching anything: after the deploy,
   hit whatever endpoint exercises the `notification_type_data` write path (per
   `TODO.md:653`) and confirm it no longer fails.

3. **Only then**, run this once, from a machine that can reach the pooler host
   (the same `MIGRATION_DATABASE_URL` used in `deploy.yml`, session mode, port
   5432 — see the long comment block above the "Apply database schema" step in
   `deploy.yml` for exactly why it has to be that URL and not the direct host):

   ```bash
   npx prisma migrate resolve --applied 20260913000000_baseline
   ```

   This does **not** run any SQL — it only writes one row into Prisma's internal
   `_prisma_migrations` tracking table, telling Prisma "this migration's effect is
   already present, don't try to re-apply it." Safe to run exactly once, after
   step 2 is confirmed.

4. **Only then**, switch `deploy.yml`'s schema step from `db push` to
   `migrate deploy`:

   ```diff
   -            npx prisma db push --schema prisma/schema.prisma
   +            npx prisma migrate deploy --schema prisma/schema.prisma
   ```

   From this point on, every schema change ships as a new file under
   `prisma/migrations/`, generated locally with `prisma migrate dev` against a
   throwaway/local database (never against the shared Supabase instance directly)
   and committed alongside the code that needs it. `migrate deploy` only ever
   applies migrations that aren't yet in `_prisma_migrations` — it never
   auto-generates or guesses a diff the way `db push` does, so a bad migration
   fails the deploy loudly instead of silently reconciling in a way nobody
   reviewed.

## What I deliberately did NOT do

- I did not run any `prisma` command against a live database — `.env`'s
  `DATABASE_URL` was confirmed to point at a live/shared Supabase project, and
  you confirmed this should be treated as production.
- I did not touch `deploy.yml`. Flipping its command before step 3 above would
  make the very next deploy fail (`CREATE TABLE` on tables that already exist).
- I did not run `prisma migrate resolve` myself, since it needs
  `MIGRATION_DATABASE_URL`, a GitHub secret I don't have.

## Once this is done

`TODO.md:653` and `TODO.md:781` should be updated to reflect that the underlying
columns are live and this migration-history gap is closed — see the audit's rank
#74 finding ("Migration applied status contradicts itself") for the exact TODO.md
lines this replaces.
