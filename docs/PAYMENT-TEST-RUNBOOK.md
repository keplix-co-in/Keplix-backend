# Keplix Payment Test Runbook

A manual, end-to-end walkthrough of the money path across all four actors:
**customer → backend → admin → vendor.**

This is the human half of the payment verification. The automated half
(`npm run test:e2e`) covers what a person can't reliably do by hand —
simultaneous requests, replayed webhooks, injected crashes. This document
covers what automation can't see: what each actor actually experiences.

> **This runs against the live Supabase database.** Every step creates real
> rows. Use the dedicated test accounts created in Part 0 so Part 6 can remove
> them cleanly.
>
> **Never run `node prisma/seed.js`.** Line 109 truncates every table in the
> database. It is a local-development script and would wipe production.

---

## Part 0 — Setup

### 0.1 Infrastructure

| Requirement | Command / note |
|---|---|
| Node deps | `npm install --legacy-peer-deps` |
| **Redis (mandatory)** | `docker run -d -p 6379:6379 redis:7-alpine` |
| Prisma client | `npx prisma generate` |
| Backend | `npm run dev` → http://localhost:8080 |
| Admin panel | `cd ../kepix-admin && npm run dev` → http://localhost:5173 |

**Redis is not optional.** `isTokenBlacklisted` in `middleware/authMiddleware.js`
fails *closed* — with Redis down, every authenticated request returns 401 and
you will misdiagnose it as an auth bug. There is no redis service in
`docker-compose.yml`; you must start it yourself. Confirm with:

```bash
curl -s localhost:8080/health | jq
# checks.database and checks.redis must both be "ok"
```

### 0.2 Environment gotchas

- **`CLOUDINARY_URL` is required** by `config/env.js` but is *absent from
  `.env.example`* — copying the example file verbatim crashes the server at
  boot with a Zod error.
- `RAZORPAY_WEBHOOK_SECRET` must be a real value. The literal
  `your_razorpay_webhook_secret_here` is explicitly rejected; without a real
  secret every webhook 500s.
- The customer app's `.env` defines `EXPO_PUBLIC_API_URL` **twice**. The second
  wins. Point it at your machine, not Cloud Run, or you'll be testing the
  deployed backend.

### 0.3 Apps

Both mobile apps use native modules (Razorpay, Google Sign-In), so **Expo Go
will not work** — you need a dev build on a real Android device or emulator.
The admin panel is a plain browser app and needs nothing special.

### 0.4 Create the test actors

Register through the real UI (this is part of what's being tested). A newly
registered user is `is_verified: false` and will 403 on everything until
verified via email OTP.

> If email isn't configured locally, the OTP is returned **in the response
> body** of `POST /accounts/auth/send-email-otp` when Resend fails and
> `NODE_ENV=development`.

Note the IDs as you go — you'll need them throughout:

```bash
# Run against the DB to collect what you just created
psql "$DATABASE_URL" -c "SELECT id, email, role FROM \"User\" ORDER BY id DESC LIMIT 5;"
```

**Rate limit warning:** `/signup`, `/login` and the OTP routes are capped at
**3 requests per 2 hours per IP**. Log in once and keep the token. If you get
locked out, `/register` is not rate-limited.

---

## Part 1 — Customer: book and pay

| # | Action | Expected | Verify |
|---|---|---|---|
| 1.1 | Open the app, browse services (`ServicesCard` / `SearchResult`) | Services list loads | — |
| 1.2 | Tap a garage → `VendorProfile` → **Book** | `BookSlot` opens | — |
| 1.3 | Pick date + time → Continue | `ReviewPage` opens. **No booking exists yet** | — |
| 1.4 | Confirm on `ReviewPage` | Booking created, app returns to `BookingList` | `SELECT id,status,vendor_status FROM "Booking" ORDER BY id DESC LIMIT 1;` → `pending` / `pending` |

**The booking is not payable yet.** The vendor must accept it first.

| # | Action | Expected | Verify |
|---|---|---|---|
| 1.5 | On the **vendor** app, accept the booking | — | Booking is now `confirmed` / `accepted` |
| 1.6 | Back on the customer app, open the booking → **Pay Now** | `Payment1` opens showing the bill | `GET /service_api/user/<userId>/bookings/<id>/can-pay` → `canPay: true` |
| 1.7 | Slide to pay | Razorpay Checkout opens | An order was created — check `razorpay.orders` or the logs |
| 1.8 | Pay with a **Razorpay test card** | Success animation → `PaymentSuccess` → `PaymentConfirmation` | See 1.9 |

**1.9 — The critical assertion.** The amount charged must come from the
service price, not the app:

```sql
SELECT p.id, p.amount, p.status, p."transactionId", p."vendorPayoutStatus",
       s.price AS service_price
FROM "Payment" p
JOIN "Booking" b ON b.id = p."bookingId"
JOIN "Service" s ON s.id = b."serviceId"
ORDER BY p.id DESC LIMIT 1;
```

`amount` must equal `service_price` exactly, `status` = `success`,
`vendorPayoutStatus` = `pending`.

### 1.10 — Interruption test (do this one deliberately)

Repeat 1.6–1.8 on a **new** booking, but **force-kill the app** immediately
after Razorpay reports success and before the success screen appears.

- Reopen the app and go to the booking.
- The client persists the payment to SecureStore before verifying and replays
  it on resume, so the booking should settle on its own.
- If the client never got to run, the webhook covers it (Part 2.3).

**Neither path may result in a charged customer with an unpaid booking.** This
is the single most valuable manual test in this document.

---

## Part 2 — Backend: observe and verify

### 2.1 Logs

```bash
tail -f logs/all.log | grep -E "\[Webhook\]|\[Payout Worker\]|\[Payout System\]|\[Reconciliation\]"
```

Note: many controllers use bare `console.error`, which goes to **stdout only**
and never reaches `logs/error.log`. Watch the terminal too.

### 2.2 Webhook delivery

Razorpay must be able to reach your machine:

```bash
ngrok http 8080
# Register https://<id>.ngrok.app/service_api/payments/razorpay-webhook in the
# Razorpay dashboard
```

To test without ngrok, synthesise a signed delivery — the signature is an HMAC
over the **exact bytes** sent, so the body must not be re-serialised:

```bash
BODY='{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_TEST1","order_id":"order_TEST1","amount":500000,"notes":{"bookingId":"123"}}}},"created_at":1700000000}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$RAZORPAY_WEBHOOK_SECRET" -r | cut -d' ' -f1)
curl -X POST http://localhost:8080/service_api/payments/razorpay-webhook \
  -H "Content-Type: application/json" \
  -H "x-razorpay-signature: $SIG" \
  -H "x-razorpay-event-id: evt_manual_1" \
  --data-raw "$BODY"
```

**Send it twice.** The first returns `{received:true}`; the second must return
`{received:true,duplicate:true}`.

```sql
SELECT * FROM "WebhookEvent" ORDER BY id DESC LIMIT 5;  -- exactly one row per event id
```

### 2.3 Webhook-only settlement

Using a booking that was **never** verified by the client, send a
`payment.captured` webhook whose `notes.bookingId` points at it. A `Payment`
row must be created and the booking confirmed — this is the safety net for
1.10.

---

## Part 3 — Vendor: complete the service

| # | Action | Expected |
|---|---|---|
| 3.1 | Vendor app → booking → mark **In Progress** | `Booking.status` = `in_progress` |
| 3.2 | Mark **Service Completed** | `Booking.status` = `service_completed` |

Illegal transitions are rejected by `controllers/vendor/bookingController.js` —
try skipping straight to completed and confirm it's refused.

---

## Part 4 — Escrow release

There are **two** independent ways a payout gets enqueued. Test both, on
separate bookings.

### 4.1 Customer confirmation

Customer app → completed booking → **Confirm** (optionally rate the service).

```sql
SELECT "vendorPayoutStatus" FROM "Payment" WHERE "bookingId" = <id>;  -- 'processing'
```

### 4.2 Admin settle

1. Open http://localhost:5173, log in as admin.
2. **Finance** → the KPI tiles must show real numbers.
   - ⚠️ The **Cash Flow Pipeline** panel is labelled *"Illustrative example"* —
     those figures are hardcoded and never change. Don't read them as data.
3. Find the booking in **Payout Queue** → **Pay Now**.
   - ⚠️ The endpoint returns **202 Accepted** — it *queues* the payout. The
     alert says "Payout Processed!" before any money has moved. **Refresh** to
     see the real outcome.

### 4.3 Watch the worker

```
[Payout Worker] Processing payout for Payment ID: N
[Payout System] Processing RazorpayX Transfer to fa_xxx
[Payout Worker] Payout successful for Payment ID: N
```

```sql
SELECT status, "gatewayPayoutId", attempts, "lastError"
FROM "PayoutSettlement" WHERE "paymentId" = <id>;
-- status must be 'settled'

SELECT "vendorPayoutStatus", "vendorPayoutId" FROM "Payment" WHERE id = <id>;
-- 'paid'
```

**If a vendor has no `VendorPayoutAccount`, the payout fails by design.** Note
that onboarding *swallows* RazorpayX failures (`profileController.js`), so a
vendor can finish onboarding with no payout account and no error shown
anywhere. Confirm the row exists before blaming the payout:

```sql
SELECT * FROM "VendorPayoutAccount" WHERE "vendorId" = <vendorId>;
```

---

## Part 5 — Vendor sees the money, and refunds

### 5.1 Vendor earnings

Vendor app → Home → earnings card → **Earnings**. The booking's badge should
flip **⏳ PENDING → ✓ PAID** (pull to refresh / re-focus the screen).

- A notification should also arrive ("💰 Payment Received!"). Push only fires
  if a `pushToken` was registered; the in-app notification list always gets it.
- ⚠️ **Known bug:** tapping an earnings row navigates to `TransactionDetails`,
  which is not registered anywhere. It will error. Don't tap it.

### 5.2 Refund

Admin panel → **Finance** → **Issue Refund**.

| Case | Input | Expected |
|---|---|---|
| Partial | Payment ID + an amount below the total | 200, `Refund` row `processed` |
| Over-refund | Another partial that would exceed the total | **Rejected** with the remaining balance in the message |
| Full | Leave amount blank | `Payment.status` → `refunded` |
| After payout | Refund a payment already `paid` out | Succeeds **with an amber warning** that the vendor was already paid and must be recovered manually |

```sql
SELECT id, amount, status, "gatewayRefundId" FROM "Refund" WHERE "paymentId" = <id>;
```

Double-click the Refund button and confirm only **one** refund is created —
the idempotency key is generated per submission specifically to make that safe.

---

## Part 6 — Teardown

```sql
-- Review before deleting
SELECT id, email FROM "User" WHERE email LIKE '%e2epay%' OR email LIKE '%<your test prefix>%';
```

The automated suite cleans up after itself. For manually created accounts,
delete in this order — `Payment→Booking`, `PayoutSettlement→Payment` and
`Refund→Payment` are all `onDelete: Restrict`, so children must go first:

```
Refund → PayoutSettlement → Payment → Review → Conversation → Booking
       → Service → VendorPayoutAccount → UserProfile/VendorProfile → User
```

---

## Appendix A — What the automated suite already proves

Run it with `npm run test:e2e` (serial — the suites share one database).
**53 tests across four tiers.**

**Tier 1 — lifecycle (16 tests).** The whole money path in order: payout
account precondition; booking starts unpayable; vendor acceptance makes it
payable; server-side pricing (a client-supplied amount is ignored); commission
split; the duplicate webhook changing nothing; vendor completion; the admin
payout queue; customer confirmation claiming the payout once; an admin settle
on the same payment being refused; the worker transferring with an idempotency
header; vendor notification and earnings; a re-run of the payout job moving no
money; then partial, capped and exhausted refunds.

**Tier 2 — adversarial (16 tests).** Free-booking via a self-reported gateway;
forged signature; valid signature over an uncaptured payment; a captured
payment for less than the booking price; a payment belonging to another order;
cross-user booking confirmation; client-supplied amount ignored; unsigned and
wrongly-signed webhooks; webhook replay; non-admin settle and refund.

**Tier 3 — concurrency (8 tests).** 8 simultaneous verifies → exactly one
payment; replayed verify never re-arms a settled payout; 8 simultaneous
settles → one payout job; both enqueue paths racing → one job; 12 parallel
identical webhooks → one event; two parallel partial refunds → total never
exceeds the payment; parallel identical refund keys → one gateway call.

**Tier 4 — failure injection (13 tests).** Gateway timeout during verify
records nothing and can be completed later; payout gateway failure marks
`gateway_failed` and retries safely; **a crash after the transfer but before
bookkeeping never transfers twice**; `reconciliation_needed` and `settled`
settlements are never re-sent; a vendor with no payout account fails rather
than guessing a destination; the webhook alone settles a booking when the
client died; a webhook whose amount doesn't match is not recorded; a stale
`payment.failed` cannot revert a success; and the reconciliation job recovers
an orphaned capture while leaving genuinely abandoned checkouts alone.

Every assertion fails loudly on HTTP 429, because a test that was
rate-limited rather than rejected by the control under test has passed for the
wrong reason.

## Appendix B — Bugs this exercise found and fixed

| Bug | Impact |
|---|---|
| **All validation errors returned HTTP 500** — `validateRequest` checked `error.errors`, the Zod v3 name; v4 uses `.issues`, so the branch never fired | Every bad-input request across the entire API reported a server fault |
| **`ratingHelper` wrote to columns that didn't exist** — `VendorProfile.rating` / `numReviews` were never in the schema | Confirming a booking **with a rating** threw, and since it ran in one transaction it rolled back the escrow release too. Also broke review create/delete |
| **Over-refund race** — balance check and refund creation weren't atomic | Two concurrent partial refunds could together exceed the payment |
| **Duplicate refund calls** — an `initiated` refund didn't block a concurrent request with the same key | Same key hit the gateway 3× in testing; money refunded repeatedly |
| **Concurrent verify returned 500s** — parallel upserts raced on the unique key | 5 of 8 simultaneous verifies failed with a server error |
| **Duplicate payout enqueue** — customer confirmation only rejected `paid`, not `processing` | A confirmation racing an admin settle could queue a second payout |
| **Admin panel could not authenticate** — read `data.token`, backend sends `accessToken` | Every admin screen silently empty; login appeared to work |
| **No refund UI existed** | Refunds were curl-only, with a hand-invented idempotency key |
| **The `WebhookEvent` and `Refund` tables were never created** | Webhook dedupe and the entire refund endpoint would have thrown in production |

### Why these were invisible before

Two test files were the reason. `tests/util/ratingHelper.test.js` defined its
own copy of the logic and asserted against that, never importing the real
helper — and used `node:test`, so under jest it registered zero cases and the
suite merely errored, which looked like a harmless config wrinkle rather than
a hidden bug. `tests/controllers/authController.test.js` died on env
validation before running. Both are now fixed and test real code; the unit
suite is 11/11 green.
