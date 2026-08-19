# Refund policy + payout hold — applied 2026-08-17

**Status: APPLIED to production** (via `prisma db execute`, DDL only — all
columns are additive with defaults, so no backfill was needed).

## Why

`services/refundService.js` could already move money safely, but nothing called
it except an admin endpoint. Its own controller says so explicitly — *"a
mechanism, not a policy... Whatever refund windows/conditions the business
settles on should be enforced by the caller (e.g. a booking-cancellation
flow)"*. Cancelling a booking refunded nothing, and the `Refund` table was
empty.

Worse, a payout could outrun a refund: `claimAndQueuePayout` checked only that
the payment succeeded and wasn't already settled — no booking status, no refund
check, no hold window. A vendor could be paid before a refund was raised, after
which `refundService` could only report `payoutAlreadySettled`, whose own
comment admits the money *"needs to be manually recovered from the vendor"*
with no mechanism to do it.

These columns are what let a policy layer exist and what give the payout path
something to refuse on.

## What was changed

```sql
ALTER TABLE "PlatformSettings" ADD COLUMN "payoutHoldHours"          INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "PlatformSettings" ADD COLUMN "autoRefundOnCancellation" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PlatformSettings" ADD COLUMN "refundGatewayFeeBorneBy"  TEXT    NOT NULL DEFAULT 'customer';
ALTER TABLE "Payment"          ADD COLUMN "payoutHoldUntil"          TIMESTAMP(3);
ALTER TABLE "Payment"          ADD COLUMN "gatewayFee"               DECIMAL(65,30);
```

`payoutHoldUntil` is deliberately on `Payment`, **not** `Booking`: the schema
rule (see the comment on `BookingVehicle`) is that `Booking`, the
payment/escrow-critical model, must not be modified. The hold is a property of
the money anyway, not the appointment.

## Rollout safety

- **`autoRefundOnCancellation` defaults to `false`.** Applying this migration
  and deploying the policy layer changes no behaviour until the flag is
  switched on deliberately. This mirrors `isHealthSheetRequired`.
- **`payoutHoldUntil` is nullable and NULL means releasable.** The payout guard
  treats a missing hold as "no hold recorded", so the ~17 payments that already
  existed are not retroactively frozen. Only bookings completed *after* deploy
  get a hold stamped on them.
- **`gatewayFee` NULL means unknown**, and the policy refunds the *full* amount
  when it can't be determined, rather than guessing a deduction and
  short-changing a customer.
- Verified after apply: settings row reads
  `payoutHoldHours=24, autoRefundOnCancellation=false, refundGatewayFeeBorneBy=customer`;
  `Payment.payoutHoldUntil` and `Payment.gatewayFee` both present and NULL.
- All three payout guards were exercised against live rows (cancelled booking,
  active hold, reserved refund) and each returned 400; state was restored and
  `Refund` count returned to 0.

## Consequence to be aware of

- **Vendor payouts can now be refused.** `POST /finance/payouts/:id/settle`
  returns 400 when the booking is `cancelled`/`refunded`/`disputed`, when a
  refund is reserved against the payment, or while the hold window is open. Any
  admin UI calling it must show the message rather than treating 400 as a bug.
- The guards live **inside** `claimAndQueuePayout`'s transaction, which already
  takes `SELECT … FOR UPDATE` on the payment row — the same lock
  `refundService` takes. That mutual exclusion is the point: a payout and a
  refund for one payment can no longer interleave.
- `refundGatewayFeeBorneBy` is seeded to `'customer'` per the current business
  decision, meaning a "free" cancellation returns *amount − gateway fee*. If
  that shortfall generates support load, flipping it to `'platform'` is a
  one-row update with no deploy.
- Note: `routes/vendor/vendorPayout.js` is **not mounted anywhere** — the
  vendor-triggered payout endpoint is dead code. Guards were added there too
  for consistency, but the live path is the admin settle route.

## To roll back

```sql
ALTER TABLE "PlatformSettings" DROP COLUMN IF EXISTS "payoutHoldHours";
ALTER TABLE "PlatformSettings" DROP COLUMN IF EXISTS "autoRefundOnCancellation";
ALTER TABLE "PlatformSettings" DROP COLUMN IF EXISTS "refundGatewayFeeBorneBy";
ALTER TABLE "Payment"          DROP COLUMN IF EXISTS "payoutHoldUntil";
ALTER TABLE "Payment"          DROP COLUMN IF EXISTS "gatewayFee";
```

To disable the behaviour without dropping columns (preferred — it keeps the
audit trail and needs no deploy):

```sql
UPDATE "PlatformSettings" SET "autoRefundOnCancellation" = false, "payoutHoldHours" = 0;
```

`payoutHoldHours = 0` makes `resolvePayoutHoldUntil` return NULL, so no new
holds are stamped; existing `payoutHoldUntil` values would still be honoured
until they elapse.
