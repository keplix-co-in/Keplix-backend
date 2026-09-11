# Backend API test report

Systematic endpoint-by-endpoint review. Living document — updated as each phase
completes.

**Status:** phase 0 complete. Seven defects found, **six fixed**, all covered by
regression tests. Suite green at 479. HTTP endpoint sweep still **blocked** on a
test database — see below.

---

## Blocker

`.env` `DATABASE_URL` points at **the production database**. Verified by row
counts: 14 published blog posts including the `summer-car-care-check` duplicate
that only exists in production, plus 54 bookings, 26 payments and 22 real users.

The existing `tests/e2e/` suites are written to run against that live database on
purpose (`tests/e2e/helpers/fixtures.js:29-31`), isolating by `TEST_TAG` rather
than by schema. The write-heavy endpoint sweep must not run there.

PostgreSQL 17.7 is installed locally and the service has been started, but the
`postgres` superuser password is unknown. Needed to proceed:

- a `DATABASE_URL` for a disposable database (local Postgres credentials, or a
  second Supabase project), then `npx prisma db push`
- `RAZORPAY_KEY_ID` beginning `rzp_test_`

`prisma/seed.js` truncates every table — it must only ever point at that database.

---

## Confirmed defects — FIXED

Each was verified in source, fixed, and is now guarded by a regression test under
`tests/regressions/`. The tests assert the correct behaviour and fail if it is
ever undone.

### Two corrections to the original findings

**D2 was not a separate defect.** I reported "`disputed` does not block
confirmation" as its own HIGH issue. It is literally true that no `disputed` check
exists in `bookingConfirmationService.js` — but confirmation requires status to be
exactly `service_completed`, which already excludes `disputed`, and the vendor
cannot move `disputed → service_completed` either. It was reachable *only* through
D1, and fixing D1 closed it. No separate fix was needed.

**D5 was narrower than stated.** I wrote that nothing ever writes
`VendorProfile.status` and that the location search "can never return a row". The
database has two `approved` vendors — `prisma/seed.js:158,338` sets them. My scan
excluded `scripts/` and `prisma/`. The real defect: no *API* path wrote the field,
so vendors who register through the app could never be approved. Five of the seven
vendors are in that state. The fix is the same either way.

### D1 — A customer can release escrow to themselves · CRITICAL

`validators/user/bookingValidators.js:18` permits `service_completed` in the
enum a **customer** may send. `controllers/user/bookingController.js:585` guards
only the `cancelled` case, then writes `status` verbatim at `:597`.
`confirmBookingAndQueuePayout` (`services/bookingConfirmationService.js:61`)
requires exactly `service_completed`.

Repro:
```
PUT  /service_api/user/:userId/bookings/update/:id   {"status":"service_completed"}
POST /service_api/user/:userId/bookings/:id/confirm  {"confirmed":true}
```
Vendor payout is queued with no vendor action and no check that the booking was
ever paid. The `payoutHoldUntil` escrow is bypassed too — it is enforced only on
the admin path (`services/payoutService.js:111`) and deliberately skipped here
(`bookingConfirmationService.js:120`).

Fix: restrict the customer enum to statuses a customer owns (realistically only
`cancelled`), and require that the payout precondition was set by the vendor.

### D2 — `disputed` does not block confirmation · HIGH

No `disputed` check exists anywhere in `services/bookingConfirmationService.js`.
Combined with D1, a customer can dispute and then confirm, clearing their own
dispute and releasing the payout. `payoutService.js:87` does check `disputed`, so
the admin path is safe — only the customer path is not.

### D3 — Vendor `status:"completed"` bypasses every transition guard · HIGH

`controllers/vendor/bookingController.js:236-254` validates the current status
only for `in_progress` and `service_completed`. `completed` has no branch, so it
is reachable from any state — including a booking never accepted and never paid.

It is also a dead end: confirmation requires exactly `service_completed`, so a
booking marked `completed` can never be customer-confirmed and its payout strands
in `pending` with no path forward but a manual admin settle. Two "done" statuses
with no reconciliation between them.

### D4 — Auto-decline cron overwrites a concurrent vendor accept · HIGH

`util/bookingStatusManager.js` filters `vendor_status: 'pending'` in the
`findMany` at `:240`, but the write at `:259` is:

```js
await prisma.booking.update({ where: { id: booking.id }, ... })
```

The guard is absent from the `where`. A vendor accepting between the read and the
write is silently reverted to `rejected`/`cancelled`. Genuine check-then-act race.

Fix: `updateMany({ where: { id, vendor_status: 'pending', status: 'pending' } })`
and treat `count === 0` as "the vendor got there first".

Related: `PENDING_TIMEOUT_MINUTES` defaults to **5**
(`bookingStatusManager.js:39-40`) despite roughly twenty lines of comment above it
stating the default is now 30. The documented fix was never applied.

### D5 — Vendor approval does not exist · HIGH

`VendorProfile.status` defaults to `"pending"` and **nothing writes it**. A scan
of all 122 source files under `controllers/`, `services/`, `routes/`, `util/` and
`middleware/` finds exactly two that update `vendorProfile` — `profileController.js`
and `ratingHelper.js` — and neither sets an approval status. `"approved"` appears
only in admin *read* queries (`Admin/vendorController.js:25,88`,
`dashBoardController.js:48`).

Live consequences:
- no verification gates a vendor from listing services or taking money
- `searchVendorsByLocation` (`user/serviceController.js:409`) filters
  `WHERE status = 'approved'` and therefore **can never return a row**
- the admin "approved vendors" KPI is permanently zero
- `Document.status` is likewise write-once `'pending'` — no endpoint approves documents

### D6 — Reschedule has no conflict or past-date check · MEDIUM

`createBooking` guards double-booking inside a transaction
(`user/bookingController.js:400-420`). `updateBooking` writes `booking_date` and
`booking_time` at `:599-600` with no equivalent check, so a reschedule can land on
a slot another customer holds, or in the past.

### D7 — Cancellation allowed after the money has moved · MEDIUM

`user/bookingController.js:585-593` blocks cancelling only when already
`completed` or `cancelled`. `user_confirmed` is cancellable — and at that point
the payout has already been queued.

### What each fix was

| # | Defect | Fix |
|---|---|---|
| D1 | Customer could write `service_completed` and self-release escrow | Customer enum narrowed to `z.enum(['cancelled'])`; controller returns 403 for any other status. Verified first that the customer app only ever sends `cancelled`. |
| D3 | Vendor `completed` bypassed every transition guard | `completed` now requires `in_progress`/`confirmed`/`scheduled`/`service_completed`. Kept working because the vendor app really does send it. |
| D4 | Auto-decline cron overwrote a concurrent accept | `update({where:{id}})` → `updateMany` with `vendor_status`/`status` in the WHERE; `count === 0` skips the notifications. |
| D5 | No API path approved a vendor | New `PATCH /admin/vendors/:id/status` with `setVendorStatusSchema`, audit-logged. |
| D6 | Reschedule had no conflict or past-date check | Guards mirroring `createBooking`, including the legacy 12-hour label. `service` added to the include so the query is scoped to the right vendor. |
| D7 | Cancellation allowed after payout queued | `NON_CANCELLABLE` now covers `service_completed`, `user_confirmed`, `disputed`. |
| — | Admin force-complete had no guard at all | Refuses `cancelled`/`user_confirmed`/`completed`. `disputed` still allowed — that is legitimate dispute resolution. |

### Deliberately NOT changed — product decisions, not bugs

- **Completion does not require payment.** Adding that gate would break cash-settled
  jobs. The payout path is already safe regardless: `confirmBookingAndQueuePayout`
  re-checks `payment.status === 'success'` under a row lock.
- **In-progress bookings can still be cancelled.** Blocking it strands a customer;
  allowing it means the vendor did work that can no longer reach the payout path.
  Both tests assert the *current* behaviour so a change is deliberate.

---

## Security review

**Clean:**
- No `queryRawUnsafe`/`executeRawUnsafe` anywhere — no SQL injection surface.
- No secrets committed in source (scanned for live keys, AWS ids, private keys).
- IDOR checks correct in every `req.params.userId` handler
  (`profileController`, `notificationController` all compare against `req.user.id`).
- `updateUserProfile` builds its update from an allow-list — no mass assignment.
- Razorpay webhook and vendor-payment verify both use HMAC + `timingSafeEqual`.
- Vendor payment *verify* ignores the client amount and reads
  `razorpay.orders.fetch(orderId).amount` — recorded revenue cannot be faked.

**Fixed in this pass:**
- Both vendor payment routes had **no validator**. `amount` reached
  `Math.round(amount * 100)` with only a truthiness check, so a non-numeric value
  became `NaN` and a negative went to the gateway unchallenged. Now validated.

**Open — needs a product decision:**
- **Vendor payment amount is still client-supplied.** The customer flow resolves
  price server-side (`resolveBookingAmount`); there is no equivalent for vendor
  plans — the price is hardcoded in the vendor app (`Payment4.jsx`, "Pay ₹10,499").
  A vendor can create a ₹1 order for a ₹10,499 plan. The real fix is a plans/prices
  table the server reads by plan id. Validation bounds the damage but does not
  close it.
- **No `package-lock.json`.** `npm audit` cannot run and builds are not
  reproducible. Worth generating one.
- Eight other write routes still have no validator: `force-complete`, `settle`,
  `refund`, both `chat/send`, promotions update, review reply, vendor feedback create.

---

## Not yet tested — needs the test database

Awaiting the blocker above. Priority order when unblocked:

| Phase | Area | Routes | Notes |
|---|---|---|---|
| 1 | Auth | ~21 | incl. 4 trailing-slash aliases; `/admin/auth/*` has no `authLimiter` |
| 2 | Booking lifecycle | ~14 | HTTP-level proof of D1–D4, D6, D7 |
| 3 | Payments + webhook | 5 | webhook-before-verify, replay, throw-suppresses-retry, double order |
| 4 | Vendor | ~35 | D5; walk-in status ping-pong; `token_expires_at` never set or checked |
| 5 | Admin | ~30 | settle/refund are real money — fake gateway only |
| 6 | User remainder + public | ~35 | job-sheet PII masking, `publicJobLookupLimiter` |
| 7 | Cross-cutting | — | `userServiceRoutes` double mount; 10 write routes with no validator |

### Already-identified leads for those phases

- **Webhook retry suppression** — the `WebhookEvent` row is committed at
  `paymentController.js:218` *before* processing, and `handlePaymentCaptured`'s
  catch at `:294` swallows. A throw marks the event processed, returns 200, and
  permanently suppresses Razorpay's retry: money captured, no `Payment` row.
- **Double capture** — `createPaymentOrder` idempotency depends on
  `razorpay.orders.all` succeeding; on failure it creates a second order
  (`paymentController.js:72-76`). The second capture is swallowed at
  `paymentService.js:278-281` with no `unresolved` flag and no alert.
- **`reconcileStalePayments`** uses `booking.service.price` and a hardcoded
  `platformFee = totalAmount * 0.1` (`util/paymentReconciliation.js:70,73`)
  instead of `resolveBookingAmount` / `resolvePlatformFeeRate`. Segment-priced
  bookings can never reconcile; a non-default commission is mis-split.
- **`autoRefundOnCancellation` defaults false** (`schema.prisma:608`), so a paid
  cancellation refunds nothing and leaves no durable record that a refund is owed
  — only a `REFUND_UNDER_REVIEW` notification.
- **Walk-in jobs** — `updateWalkInJobStatus` has no transition guard at all
  (`completed → open → completed` is permitted, overwriting `completed_at`), and
  `resendWalkInJobNotification` has no rate limit, so a vendor can spam SMS to any
  number they typed in.
- **Ten write routes have no validator**: both vendor payment routes,
  `force-complete`, `settle`, `refund`, both `chat/send`, promotions update,
  review reply, vendor feedback create.
