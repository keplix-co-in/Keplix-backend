# Vendor subscriptions + pay-the-garage (API contract, 2026-11-23)

Owner decision 2026-11-22: customers pay the garage directly (cash / the garage's UPI). The payment gateway
(Razorpay) is used ONLY for garage subscriptions. Design reference: artifact "keplix-subscription-blueprint"
(https://claude.ai/artifact/VWQ4rGZhXExV89dar9W6TR, v4).

## Owner decisions (2026-11-23)
- Free trial: **90 days of Gold** for every vendor. Existing approved vendors get 90 days from the day this ships
  (lazy: the trial row is created the first time a vendor's subscription is read or checked).
- Expiry: **7-day grace** (reminders, still listed), then the garage is **hidden** from customers and cannot take new
  bookings. Bookings already made can still be finished.
- Renewal: **manual** (vendor taps Pay each period). No autopay / mandates.
- Unfinished bookings: **all switch now** to pay-the-garage. Bookings already paid online are NOT refunded
  automatically: `scripts/listPaidUnfinishedBookings.js` (read-only) prints them for the owner to decide.
- Prices and features live in the DB (`SubscriptionPlan`) and are editable from the admin panel. Seed values below.
- Old customer-payment code is deleted (git history keeps it). Backend payment/payout/refund **models stay** (no drops).

## Schema (additive only, `prisma db push` safe)
```
SubscriptionPlan     id, code @unique ('silver'|'gold'|'platinum'), name, monthly_price Decimal(10,2),
                     yearly_price Decimal(10,2), features Json (string[]), sort_order Int, is_active Bool, updated_at
VendorSubscription   id, vendorId Int @unique (User.id), plan_code, period ('trial'|'monthly'|'yearly'),
                     starts_at, ends_at, created_at, updated_at, last_reminder_at DateTime?
SubscriptionPayment  id, vendorId, plan_code, period, amount Decimal(10,2), razorpay_order_id @unique,
                     razorpay_payment_id String? @unique, status ('created'|'paid'|'failed'), paid_at, created_at
ExtraWorkItem        + job_key String? @db.VarChar(40)   -- items with the same job_key are one job (part + labour)
FinalBill            + paid_method String? ('cash'|'upi'|'card'|'online')  + marked_paid_by Int?
```
Seed (upsert by code, only if missing): silver ₹499/mo ₹4,990/yr; gold ₹999/mo ₹9,990/yr; platinum ₹1,999/mo
₹19,990/yr. Features: silver ["Listing in your area","Up to 30 bookings a month","Bills and job tools"];
gold ["Priority listing in your area","Unlimited bookings","Bills, invoices & job tools","Customer reviews badge"];
platinum ["Everything in Gold","Top of your area","Featured badge","₹500 ad credit"].

Status is **derived**, never stored: `now < ends_at` → `trial` (period trial) or `active`; `now < ends_at + 7d` →
`grace`; else `expired`. Helper `util/subscription.js`: `getOrCreateSubscription(vendorId)`,
`subscriptionStatus(sub, now)`, `isVendorVisible(vendorId)`, and a Prisma `where` fragment for listing queries.
Renewal: new `ends_at = max(now, ends_at) + (30 days | 365 days)`; plan_code/period replaced.

## Endpoints (vendor = approved vendor from the token)
| Method | Path | Body / result |
|---|---|---|
| GET | `/subscriptions/plans` (public) | `[{code,name,monthly_price,yearly_price,features,sort_order}]` active only, numbers in rupees |
| GET | `/subscriptions/me` (vendor) | `{plan_code, plan_name, period, status, starts_at, ends_at, grace_ends_at, days_left}` |
| POST | `/subscriptions/order` (vendor) | `{plan_code, period:'monthly'\|'yearly'}` → `{order_id, amount (paise), currency:'INR', key_id, plan_code, period}`; amount from DB only |
| POST | `/subscriptions/verify` (vendor) | `{razorpay_order_id, razorpay_payment_id, razorpay_signature}` → HMAC check → mark paid + extend (idempotent) → `/me` shape |
| GET | `/subscriptions/payments` (vendor) | own history |
Webhook: existing Razorpay webhook handles `payment.captured`/`order.paid` whose order notes have
`type:'subscription'` → same idempotent mark-paid. Order `notes: {type:'subscription', vendorId, plan_code, period}`.

Admin (`authAdmin`, super_admin for writes): `GET/PUT /admin/subscriptions/plans[/:code]` (prices ≥ 0, features
string[] ≤ 10, is_active), `GET /admin/subscriptions/vendors?status=` (vendor, plan, status, ends_at),
`POST /admin/subscriptions/vendors/:vendorId/extend {days 1–730, reason}` (audit-logged), `GET /admin/subscriptions/payments`.

## Visibility
- Every customer-facing vendor/service listing, search, nearby and detail query excludes vendors whose status is
  `expired`. Booking create for such a vendor → 403 `GARAGE_UNAVAILABLE`.
- Vendor app/portal still work for an expired vendor (they can see jobs, finish existing bookings and renew).
- Daily cron (existing dispatcher): reminders (in-app + push) at 7, 3, 1 days before `ends_at`, and daily in grace;
  `last_reminder_at` prevents doubles.

## Pay-the-garage (all bookings)
- `createPaymentOrder` / quote / client verify for customer bookings → **410 `PAY_AT_GARAGE`**. `can-pay` → false,
  reason `PAY_AT_GARAGE`. Webhook still processes events for already-created old orders (no money is lost).
- `POST /service_api/vendor/bookings/:id/final-bill/mark-paid` `{method:'cash'|'upi'|'card'}` — own booking, bill
  `issued` → `paid`, `paid_at`, `paid_method`, `marked_paid_by`; audit event; notifies customer; idempotent. Legacy
  (non-v2) bookings: completion no longer requires a Payment row.
- Pricing object gains `pay_to: {upi_id: string|null, garage_name}` (garage `VendorProfile.upi_id`) so U07 can show
  the UPI ID + a `upi://pay?pa=..&pn=..&am=..&tn=Bill KPX-..` QR. Customer never confirms payment; the garage does.
- Payout/commission logic is not called for new bookings (nothing collected online).

## Extra work: one decision per job
- `POST extra-work` items accept optional `job_key` (client-generated, e.g. "j1"). Part + labour of one job share it.
  Items without job_key are their own job.
- Customer `decision`: if any item of a job_key is in `approve`, all pending items of that job must be in `approve`
  (same for reject) → else 400 `JOB_SPLIT_NOT_ALLOWED`. Server-enforced so old apps cannot split.
- Pricing object items include `job_key`; apps group by it.

## Errors
Same envelope as PRICING_V2_API.md: `{error:{code,message}}`.

---

## Implementation notes (backend, 2026-11-23)

Decision reference: owner decision 2026-11-22 (customers pay the garage directly; the gateway is used only for garage subscriptions).

### Mount paths
- Vendor: `/subscriptions/plans` (public), `/subscriptions/me`, `/subscriptions/order`, `/subscriptions/verify`, `/subscriptions/payments`. Everything except `/plans` needs a logged-in, approved vendor.
- Admin: `/admin/subscriptions/plans` (GET, PUT `/plans/:code`), `/admin/subscriptions/vendors` (GET), `POST /admin/subscriptions/vendors/:vendorId/extend`, `/admin/subscriptions/payments` (GET). Reads: any admin. Writes (PUT plan, extend): super_admin.

### Response shapes (all dates are ISO strings, amounts are whole rupees unless noted)
- `GET /plans`: `[{ code, name, monthly_price, yearly_price, features: string[], sort_order }]` (active plans only).
- `GET /me`: `{ plan_code, plan_name, period: 'trial'|'monthly'|'yearly', status: 'trial'|'active'|'grace'|'expired', starts_at, ends_at, grace_ends_at, days_left }`. `days_left` = whole days to `ends_at`, never negative. Status is derived from `ends_at` (now < ends_at: trial/active; up to ends_at + 7d: grace; after: expired).
- `GET /payments`: `[{ id, plan_code, period, amount, status, paid_at | null, created_at }]`.
- `POST /order` (body `{ plan_code, period }`; any client amount is ignored): `{ order_id, amount (paise), currency: 'INR', key_id, plan_code, period }`.
- `POST /verify` (body `razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature`): same shape as `/me`.
- Admin `GET /plans`: as `/plans` plus `is_active`, all plans. `PUT /plans/:code`: the updated plan plus `is_active`.
- Admin `GET /vendors` (`?status=trial|active|grace|expired&limit=`, max 100): `[{ vendor_id, vendor_name, email, plan_code, period, status, ends_at }]`.
- Admin `POST /vendors/:vendorId/extend` (`{ days 1-730, reason 3-300 }`): `{ vendor_id, plan_code, period, status, ends_at }`. Extends from `max(now, ends_at)`.
- Admin `GET /payments`: `[{ id, vendor_id, vendor_name, plan_code, period, amount, status, razorpay_order_id, razorpay_payment_id, paid_at, created_at }]`.

### Deviations / choices where the contract was ambiguous
- Errors use a dual envelope: `{ success:false, message, code, error:{ code, message } }`.
- Pay-the-garage: `POST /bookings/:id/final-bill/mark-paid` (vendor, `{ method: 'cash'|'upi'|'card' }`) added. Pricing view gains `can.mark_paid`, `pay_to { upi_id, garage_name }`, `bill.paid_method`; `can.pay` is always false. Customer payment endpoints (create order, quote, verify) answer 410 `PAY_AT_GARAGE`.
- Confirm and auto-confirm work with no Payment row: the booking closes as `user_confirmed` with no payout.
- Extra-work items accept an optional `job_key`; a job's pending items must be approved/rejected together (400 `JOB_SPLIT_NOT_ALLOWED`).
- Hidden garages (past grace): filtered from service lists, detail, featured, by-vendor and nearby; booking create answers 403 `GARAGE_UNAVAILABLE`.
- Trial rows are created lazily on first read/gate check, and by the reminder job for approved vendors without one.
- Reminders run on the existing 10-minute status tick (Cloud Run may scale to zero, so no daily cron), at 7, 3 and 1 days before `ends_at`, then daily through grace; claimed by `last_reminder_at` (20h gap). The push `screen` value `'Subscription'` is a guess; confirm against the vendor app route name.
- Webhook: subscription orders are detected by notes plus a matching SubscriptionPayment row; an unmatched order falls through to the old booking path so no money goes unrecorded.
- Plan price below Rs 1: 422 `INVALID_PLAN_PRICE`. Verify on an uncaptured payment: 409 `PAYMENT_NOT_CAPTURED`. Gateway failure on order: 502 `GATEWAY_ERROR`.
- Admin actions are audit-logged via the logger only (no admin audit table).
- `scripts/listPaidUnfinishedBookings.js` is read-only and lists bookings with a successful Payment that are not yet finished; run it manually against the real DB when wanted.
- Plans are seeded by code when missing (silver 499/4990, gold 999/9990, platinum 1999/19990) and editable afterward.
