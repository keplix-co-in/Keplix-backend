# Redis removal — Postgres blacklist + job queue — 2026-08-19

**Status: NOT YET APPLIED to production.** Apply before or with the deploy that
carries the Redis removal, or the backend will 401 every authenticated request.

## Why this migration is load-bearing

Redis was removed from the app entirely (it had repeatedly exhausted the hosted
command quota, and a quota error took the whole backend down). Two things that
lived in Redis moved into Postgres:

| Was in Redis                | Now                                  |
| --------------------------- | ------------------------------------ |
| `auth:blacklist:<token>`    | `BlacklistedToken` table             |
| BullMQ queues (3)           | `BackgroundJob` table                |
| `auth:user:<id>` cache      | nothing — reads the DB directly      |

`BlacklistedToken` was already declared in `schema.prisma` but had never been
used, and — critically — **was never created in any database**. Nothing in
`prisma/migrations_applied/` creates it. `BackgroundJob` is new here.

## Why production breaks without it

`middleware/authMiddleware.js` checks the blacklist on **every** authenticated
request, and fails closed:

```js
} catch (error) {
  console.error("Auth blacklist read error:", error);
  return true;   // treated as blacklisted
}
```

If `BlacklistedToken` does not exist, that query throws on every request, the
catch returns `true`, and every user gets `401 "Token has been logged out"`.
The failure is total and looks nothing like a missing table.

This is exactly why the backend works locally but not in production or preview:
local databases got both tables from `prisma db push`; deployed ones never did.
**`.github/workflows/deploy.yml` runs no Prisma step at all** — no `db push`, no
`migrate deploy`, no `generate` — so schema changes only ever reach a deployed
database when someone applies them by hand, as with every migration in this
directory.

Without `BackgroundJob` the app still serves traffic, but the dispatcher errors
every 10 seconds and no notification or vendor payout is ever processed.

## What this changes

Additive DDL only — two tables, four indexes. No existing table is touched and
no backfill is required, so it is safe to run against a live database. Every
statement uses `IF NOT EXISTS`, so re-running it is a no-op.

## How to apply

Against each environment's `DATABASE_URL` (production **and** preview):

```bash
npx prisma db execute --file prisma/migrations_applied/2026-08-19_redis_removal/001_redis_removal.sql --schema prisma/schema.prisma
```

Or equivalently, from a checkout pointed at that database:

```bash
npx prisma db push
```

Verify afterwards:

```sql
SELECT to_regclass('"BlacklistedToken"'), to_regclass('"BackgroundJob"');
-- both must be non-null
```

## Follow-up worth doing

Deploys silently skipping schema changes is the root cause here and will cause
this again. Adding a `npx prisma migrate deploy` (or `db push`) step to
`.github/workflows/deploy.yml` would make schema and code ship together.
