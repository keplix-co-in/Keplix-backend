# Backend audit harness

Not part of the deployed app or the CI jest suite (`npm test` excludes this
directory — see the ignore pattern note below if that ever needs enforcing).
This is a manual tool for exercising the whole backend end-to-end against a
real, throwaway database — the mocked jest suite already missed real bugs
(the advisory-lock 500, the admin vendor-approval 500) because a mock cannot
disagree with the real database or the real Prisma client.

## What it is

- `harness.mjs` boots the actual `app.js`/`socket.js` in one Node process,
  pointed at a scratch Postgres database, with every external service
  (Cloudinary, Razorpay, Twilio, Resend, Firebase, VAPID) either unset or a
  fake credential. Nothing it does can reach a real payment gateway, send a
  real email/SMS/push, or touch production data.
- `seed.mjs` creates a standard set of rows (two customers, two vendors — one
  approved, one pending — three services, a vehicle, an admin).
- `assertShape.mjs` scans any JSON response for the `{}`-date /
  `{s,e,d}`-price bug class found in the 2026-09-26 audit, so every new flow
  test checks for it automatically.

## Running one module's audit

1. **One-time setup**, a throwaway Postgres cluster on this machine (never the
   real `DATABASE_URL`):
   ```bash
   initdb -D /path/to/scratch/pgdata -A trust -U postgres -E UTF8
   pg_ctl -D /path/to/scratch/pgdata -o "-p 55432" -l pg.log -w start
   psql -h localhost -p 55432 -U postgres -c "CREATE DATABASE keplix_audit_<module>"
   ```
2. **Push the schema** into that database (never `MIGRATION_DATABASE_URL`
   pointed at anything real):
   ```bash
   DATABASE_URL="postgresql://postgres@localhost:55432/keplix_audit_<module>" \
     npx prisma db push --schema prisma/schema.prisma
   ```
3. **Write `tests/audit/<module>.flow.mjs`**:
   ```js
   process.env.AUDIT_DB_NAME = 'keplix_audit_<module>';
   const { seed: seedFn } = await import('./seed.mjs');
   const { prisma, bcrypt, call, token, adminToken, listRoutes, shutdown } = await import('./harness.mjs');
   import { scanForBrokenShapes } from './assertShape.mjs';

   const ids = await seedFn(prisma, bcrypt);
   // ... exercise routes with call(), assert status + scanForBrokenShapes(res.json) === []
   await shutdown();
   ```
4. **Run it** with plain Node (not jest — it needs a live server and real
   timers): `node tests/audit/<module>.flow.mjs`.
5. **Truncate between runs** so re-running is idempotent:
   `TRUNCATE "User","Admin" RESTART IDENTITY CASCADE;` (cascades to every
   dependent table).

## Rules for anyone extending this

- Never point `DATABASE_URL` or `MIGRATION_DATABASE_URL` at anything but the
  scratch cluster. Never run these scripts against Supabase or any URL from a
  real `.env`.
- Never use real Razorpay/Twilio/Resend/Firebase/VAPID credentials here, even
  temporarily — the harness's fake ones are deliberate.
- A finding is "real" only once reproduced this way — a plausible-looking
  code read is not enough (see `.claude/PROJECT_LOG.md`, 2026-09-26, for two
  bugs the mocked jest suite missed entirely).
- Fix the same class of bug you find (add a real jest regression test under
  `tests/regressions/`, matching the existing ones), but leave anything
  requiring a product or security decision (payment gateway keys, JWT
  secrets, schema changes) flagged rather than changed.
