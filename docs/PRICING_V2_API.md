# Pricing v2: pricing types, extra-work approval, final bill (API contract)

Branch `feature/pricing-invoice` (backend, keplix-frontend, user_keplix, keplix-webpage-vendors).
Plan: owner-approved scope v2, 2026-11-20. This file is the single contract that the backend and the
three clients are built against. If you change the API, change this file in the same commit.

## Scope (owner, 2026-11-20)
- Build the reference screens and the flow: priced service → booking snapshot → check-in/inspection →
  extra work approved per item by the customer → final bill from approved lines → customer pays the bill.
- **Money model unchanged:** no labour commission. The existing fee model (`feeModel 'on_top'`,
  platform fee added on top for the customer) stays. The final bill total is the *service amount*
  that the existing payment code charges and adds the fee to.
- Consumables listed as their own line count as `part`.
- Deferred: booking deposit, subscription model, settlement screen, GST lines.

## Feature switch and "v2 booking"
- `PlatformSettings.pricingV2From` is NO LONGER READ (owner 2026-11-21): every new booking is v2. The column stays only to avoid a destructive schema change.
- When a booking is created at or after `pricingV2From`, the backend writes a `BookingQuote` row.
  **A booking is "v2" if and only if it has a `BookingQuote`.** Bookings without one behave exactly as today:
  pay after accept, the same amounts, the same crons.
- `Booking` gets NO new columns (schema rule). All new booking data lives in side tables with an FK to Booking.

## Money
- The server computes every amount, in integer paise internally. The API returns rupees as JS numbers
  with 2 decimals (for example `1499`, `2800.5`). Clients never send totals; they only send line inputs,
  item ids and decisions.
- `line_total = qty × unit_price`. Removal lines and the waiver line have a negative `line_total`.
- A bill total is never below 0.

## 1. Services (vendor app + partner portal)
Existing endpoints (multipart, because of the image):
`POST /service_api/vendor/:vendorId/services/create`, `PUT /service_api/vendor/:vendorId/services/update/:id`.

Both payload types reach these endpoints: **multipart** (a save with an image) sends every field as a string, so arrays
are JSON strings, booleans are `"true"`/`"false"` and numbers are numeric strings; **JSON** (a save without an image) sends
`price_lines` / `inclusions` / `exclusions` / `segment_prices` as real arrays, `tax_inclusive` as a boolean and
`inspection_fee` / `price` as numbers. The server accepts both shapes for every field below, on both create and update,
whatever the request's content type (the vendor app's plain-JSON save sends the arrays as JSON **strings**; the portal
sends real arrays; both work).

New optional fields:

| field | type | rule |
|---|---|---|
| `pricing_type` | `'fixed' \| 'starting' \| 'inspection'` | default `'fixed'` |
| `price_lines` | JSON string `[{segment, kind, name, qty, unit_price}]` | `segment`: `null` (base) or `HATCHBACK\|SEDAN\|COMPACT_SUV\|MUV\|LUXURY`; `kind`: `'labour'\|'part'`; `name` 1–80 chars; `qty` > 0 (max 2 decimals); `unit_price` ≥ 0 |
| `inclusions` | JSON string `string[]` | each 1–80 chars, max 20; **required (≥1) for `starting`** |
| `exclusions` | JSON string `string[]` | each 1–80 chars, max 20 |
| `price_change_note` | string ≤ 300 | "what can change the final price" |
| `inspection_fee` | number ≥ 0 | **required for `inspection`** (0 allowed); ignored otherwise |
| `tax_inclusive` | boolean | default `true` |

Rules:
- `fixed` and `starting` need ≥1 base line (`segment: null`). `inspection` needs no lines; its base price is `inspection_fee`.
- The server sets `Service.price` = the sum of the base lines (`inspection`: = `inspection_fee`). For every segment that has lines,
  it upserts `ServiceSegmentPrice.price` = the sum of that segment's lines, and deletes segment prices whose segment has no lines.
  The client's `price` / `segment_prices` are **ignored when `price_lines` is present**.
- When `price_lines` is present, `price` may be ≥ 0 (an inspection fee of ₹0, or all lines at ₹0, is valid) and a segment
  whose total is 0 may be left out of `segment_prices`; both are ignored anyway. `price_lines` holds at most 100 lines.
- `price_lines: []` (what inspection-first services send) deletes all the service's lines **and** all its
  `ServiceSegmentPrice` rows, so the customer app no longer shows a car-type label for that service. This is intended
  and safe (checked 2026-11-20): neither the backend listing/search endpoints nor the customer app filter services by
  car type. Segment rows only drive the price shown for a car type and the "N car types" label; a service with no rows
  is listed for every car at its base price (`resolveBookingAmount` falls back to `Service.price` = the fee). So the
  delete is kept for `inspection` too, rather than keeping stale segment prices that no longer match the flat fee.
- The old `price > 0` / segment price `> 0` checks apply **only** to a legacy save (no `price_lines`, type not
  `inspection`). With pricing fields, a ₹0 `inspection_fee` and ₹0 `unit_price` lines are valid.
- When `price_lines` is present, the server sets `breakdown_confirmed = true`.
- **Which path an update takes** (partial updates are normal, e.g. the pause toggle sends only `{is_active}`):
  - `price_lines` sent (or `pricing_type: 'inspection'`) → the v2 rules above.
  - `price` and/or `segment_prices` sent **without** `price_lines` → the legacy payload rule below.
  - no pricing field at all (`price`, `segment_prices`, `price_lines`, `pricing_type`, `inspection_fee`) → the stored
    lines, `price` and segment prices are left untouched. Text fields (`inclusions`, `exclusions`, `price_change_note`,
    `tax_inclusive`) update on their own without changing any lines.
  - `pricing_type` / `inspection_fee` sent without `price_lines` on a service that already has v2 lines → the stored
    lines are kept and the totals are recomputed from them under the new type/fee.
  - The type rules (`starting` needs an inclusion, `inspection` needs a fee, `fixed`/`starting` need a base line) are
    checked against the service as it will be after the update (body merged with the stored row).
- **Legacy payload** (no `price_lines`, from old app builds or old portal forms): behaves exactly as today, and the server
  also stores one base labour line `{name:"Service charge", qty:1, unit_price: price}` plus one labour line per segment price.
  It sets `pricing_type 'fixed'` and `breakdown_confirmed=false`.
- **Existing services** (no lines yet) are treated the same way on read: the server synthesises the legacy lines in the
  response and sets `breakdown_confirmed: false`. No data migration is required.

Service objects in every service response (vendor list/detail, user service list/detail/provider pages) gain:
```json
{
  "pricing_type": "fixed",
  "price_lines": [{"id": 1, "segment": null, "kind": "labour", "name": "Brake service labour", "qty": 1, "unit_price": 1200, "line_total": 1200}],
  "inclusions": ["Brake cleaning"], "exclusions": ["Brake discs"],
  "price_change_note": "Price may change if discs are worn",
  "inspection_fee": null, "tax_inclusive": true, "breakdown_confirmed": true,
  "labour_total": 1200, "parts_total": 2800
}
```
(`labour_total`/`parts_total` are for the base segment.)

## 2. Booking create (customer)
This is unchanged for clients. When v2 is on, the server snapshots the service into `BookingQuote` + `BookingQuoteLine`
(the lines for the booking's segment when that segment has lines, otherwise the base lines), in the same transaction as
the existing `BookingVehicle` snapshot. For `inspection`, the quote has one labour line `{name:"Inspection fee", qty:1, unit_price: inspection_fee}`.

## 3. The pricing object (both sides)
- `GET /service_api/vendor/bookings/:id/pricing` (the booking's own vendor only)
- `GET /service_api/user/bookings/:id/pricing` (the booking's own customer only)

Both return:
```json
{
  "flow": "v2",
  "quote": {
    "pricing_type": "starting", "segment": "SEDAN",
    "inclusions": [], "exclusions": [], "price_change_note": "", "inspection_fee": null, "tax_inclusive": true,
    "lines": [{"id": 10, "kind": "labour", "name": "AC check", "qty": 1, "unit_price": 1499, "line_total": 1499}],
    "labour_total": 1499, "parts_total": 0, "total": 1499
  },
  "job": {"checked_in_at": null, "odometer_km": null, "fuel_level": null, "condition_note": null,
          "inspection_started_at": null, "work_started_at": null, "work_completed_at": null},
  "requests": [{
    "id": 5, "number": 1, "reason": "Brake pads worn below 2mm", "status": "pending",
    "supersedes_id": null, "call_requested_at": null, "created_at": "...",
    "items": [{"id": 9, "kind": "part", "name": "Front brake pads", "qty": 1, "unit_price": 2200, "line_total": 2200,
               "quote_line_id": null, "decision": "pending", "decided_at": null}],
    "approved_total": 0, "pending_total": 2200
  }],
  "bill": null,
  "running_total": 1499,
  "can": {"check_in": false, "start_inspection": false, "start_work": false, "complete_work": false,
          "request_extra_work": true, "issue_bill": false, "void_bill": false, "pay": false}
}
```
- **No envelope:** both GET endpoints return the pricing object itself as the JSON body (not wrapped in `{data}` or
  `{success, data}`). Every §4/§5 action returns the same object (updated) the same way, plus `request_id` (extra-work
  create) or `lapsed_item_ids` (final-bill). Errors use the error format at the end.
- For a legacy booking: `{"flow": "legacy"}` and nothing else.
- **Status codes:** 200 for a booking the caller owns (v2 or legacy). 404 only when the booking id does not exist, 403
  `FORBIDDEN` when it belongs to someone else. The customer app treats a 404 from this route as "legacy" (an old
  backend without the route), so it must **never** 404 for a real v2 booking the caller owns.
- **`pricing_flow` on booking rows:** the user booking list (`GET /service_api/user/:userId/bookings`,
  `GET /service_api/user/bookings`), the user booking detail (`GET /service_api/user/:userId/bookings/:id`) and the vendor
  booking list (`GET /service_api/vendor/:vendorId/bookings`) add `pricing_flow: 'v2' | 'legacy'` to every booking,
  derived from whether a BookingQuote exists (no Booking column). Apps use it to pick the payment flow without an
  extra `/pricing` call.
- `running_total` = quote total + approved items (+ waiver once a bill exists).
- `bill` once issued:
  `{id, number:"KPX-2026-000123", status:'issued'|'paid'|'void', lines:[{kind,name,qty,unit_price,line_total,source:'quote'|'extra'|'waiver'}], labour_total, parts_total, total, tax_inclusive, issued_at, paid_at}`.
  `bill.tax_inclusive` is copied from the booking quote (the bill is built from the quote's prices).
- `can.*` is computed by the server for the caller's role. Clients show and hide buttons from `can`, never from their own logic.

## 4. Vendor actions (`/service_api/vendor/bookings/:id/...`, vendor from the token, approved vendor, own booking, v2 only)

| method + path | body | effect |
|---|---|---|
| `POST check-in` | `{odometer_km?: int, fuel_level?: 'empty'\|'quarter'\|'half'\|'three_quarter'\|'full', condition_note?: string≤500}` | Allowed when vendor_status=accepted and status ∈ confirmed/scheduled. Sets `checked_in_at`; status → `in_progress` through the existing guarded transition. |
| `POST inspection/start` | — | Needs check-in. Sets `inspection_started_at`. |
| `POST work/start` | — | Needs check-in. Sets `work_started_at`. |
| `POST work/complete` | — | Needs work started. Sets `work_completed_at`. |
| `POST extra-work` | `{reason: string 3–300, items: [{kind:'labour'\|'part'\|'removal', name, qty, unit_price, quote_line_id?}] (1–20), supersedes_id?: int}` | Allowed after check-in and before a bill is issued. `removal` needs `quote_line_id` of a quote line in this booking; the server derives its negative `line_total` from that line (qty/unit_price in the body are ignored). `supersedes_id` must be a pending or partially-decided request of this booking: its still-pending items become `superseded` and its status becomes `superseded`, while already-approved items stay approved (owner rule: an approved line is never edited). Requests are immutable once sent. |
| `POST final-bill` | — | Allowed after check-in. **Idempotent:** if a non-void bill exists, it returns it with 200. Pending items → `lapsed` (excluded). Builds the lines: quote lines + approved items + the waiver. Issues the number `KPX-{IST year}-{6 digits}` from the `BillNumberCounter` table (one row per year, incremented with `INSERT ... ON CONFLICT` inside the bill transaction) instead of a DB sequence, so numbering restarts each year and needs no hand-made SQL object. |
| `POST final-bill/void` | `{reason: string 3–300}` | Only while the bill is `issued` (not paid). Marks it void; the vendor can then issue a new one. |

Final-bill rule on pending items: pending items lapse automatically, and the response includes `lapsed_item_ids` so the
garage UI can warn first ("2 items still waiting for the customer will not be on the bill"). The client confirms before calling.

**Inspection waiver:** for `inspection` quotes, if the approved non-removal extra items total ≥ `inspection_fee`, the bill
gets a line `{kind:'labour', name:"Inspection fee waived", qty:1, unit_price:-fee, source:'waiver'}`.

**Completion gate:** the existing `service_completed` status update (vendor `bookings/update/:id`) is rejected for a v2
booking with `409 {code:"BILL_NOT_ISSUED"}` unless a bill with status issued|paid exists. The health-sheet gate is unchanged.

## 5. Customer actions (`/service_api/user/bookings/:id/...`, the booking's own customer only, v2 only)

| method + path | body | effect |
|---|---|---|
| `POST extra-work/:requestId/decision` | `{approve: int[], reject: int[]}` | Each id must be a `pending` item of that request. Any other id → 409 `ITEM_NOT_PENDING` (nothing is applied). An id in both lists → 400. Records `decided_at`, `decided_by` (userId) and `app_version` (header `x-app-version` if sent). Request status → `approved` / `rejected` / `partially_approved` (some items decided) / stays `pending`. |
| `POST extra-work/:requestId/call-request` | — | Sets `call_requested_at` and notifies the garage. **Never approves anything.** |

The vendor has **no** endpoint that can approve or reject items.

## 6. Payment (v2 bookings)
- `createPaymentOrder` and the quote endpoint: for a v2 booking, the service amount = `bill.total` of the issued bill.
  No issued bill → `409 {code:"BILL_NOT_READY"}`. A paid bill → the existing "already paid" behaviour.
- All 3 amount paths (order create, client verify, webhook reconcile) resolve the amount through one helper (`util/servicePricing.js` warns about drift).
- On successful payment: `FinalBill.status='paid'`, `paid_at`.
- `GET /service_api/user/:userId/bookings/:id/can-pay`: for v2, returns false with reason `BILL_NOT_READY` until a bill is issued.
- A voided bill can't be paid. If a Razorpay order exists for a voided bill, verify/reconcile must reject the amount mismatch (existing amount check).
- **Crons:** any cron that cancels or expires *unpaid accepted* bookings must skip v2 bookings, because they are unpaid until the bill.
  Auto-confirm after `service_completed` must not trigger payout for an unpaid v2 booking. **Verified:** the auto-confirm query requires `payment.status='success'`, so an unpaid v2 booking simply waits.

## 7. Notifications + live updates
Every vendor/customer action above emits the socket event `booking:pricing_updated` `{bookingId}` to both parties, so
clients refetch `/pricing`. It also creates an in-app notification + push:

| type | to | title / body |
|---|---|---|
| `job_checked_in` | customer | "Your car has been checked in" / "{garage} has started your booking #{id}." |
| `extra_work_requested` | customer | "Approval needed" / "{garage} recommends extra work. Review and approve or reject each item." |
| `extra_work_decided` | vendor | "Customer responded" / "Booking #{id}: {n} approved, {m} rejected." |
| `extra_work_call_requested` | vendor | "Customer wants a call" / "Booking #{id}: call the customer about the extra work." |
| `final_bill_issued` | customer | "Your final bill is ready" / "Booking #{id}: ₹{total}. Review and pay." |
| `final_bill_voided` | customer | "Bill updated" / "The garage corrected your bill for booking #{id}." |
| `work_completed` | customer | "Work completed" / "{garage} has finished the work on booking #{id}." |

Push `data`: `{type, bookingId}`, plus `requestId` for `extra_work_requested`, `extra_work_decided` and
`extra_work_call_requested`, and `billId` (+ the latest `requestId`, when the booking has any request) for
`final_bill_issued`. Mobile apps route by `type` to the booking screen.

**Casing:** every pricing v2 `type` is **lower snake case** exactly as in this table (plus `final_bill_reminder`, title
"Your bill is waiting", for the reminders below). The older notification types are UPPERCASE
(`BOOKING_CONFIRMED`, ...); that split is deliberate and stays as is. Both apps match types case-insensitively.
Unpaid-bill reminders: a reminder push at 24h and 72h after `issued_at` if still unpaid (in the existing cron runner).

## 8. Audit
`BookingEvent {bookingId, actor_role:'user'|'vendor'|'system', actor_id, type, payload Json, created_at}`, written for
every action in §4–§6.

## Error format
Existing format `{success:false, message, code}`. Codes: `NOT_V2`, `NOT_CHECKED_IN`, `BILL_EXISTS`, `BILL_NOT_ISSUED`,
`BILL_NOT_READY`, `BILL_PAID`, `ITEM_NOT_PENDING`, `REQUEST_CLOSED`, `INVALID_QUOTE_LINE`, `FORBIDDEN` (403).

## Implementation notes and deviations (backend, 2026-11-20)
Where the build differs from, or adds to, the text above. Each one is the smallest safe choice; the code has a WHY comment.

- **Check-in** is also allowed from `in_progress` when no job exists yet (an older vendor app may already have used the
  legacy "start" button). A second check-in → 409 `ALREADY_CHECKED_IN`; a booking in another status → 409 `INVALID_STATE`.
- **Slot-time crons skip v2 bookings:** the activation cron (confirmed → in_progress at slot time) and the late-start
  cron both filter `bookingQuote: { is: null }`. A v2 booking starts at check-in and stays `confirmed` until then.
- **One open bill** is enforced in the DB by a unique `FinalBill.open_booking_id` (set while issued/paid, cleared on void).
  A race on issue returns 409 `BILL_EXISTS`. A bill has at most 100 lines.
- **Not a v2 booking** → 409 `NOT_V2` on every action. Extra codes used besides the list below: `INVALID_STATE`,
  `ALREADY_CHECKED_IN`, `WORK_NOT_STARTED`, `NOT_FOUND` (404), `VALIDATION_ERROR` (400), `INTERNAL_SERVER_ERROR` (500).
- **Action responses** are the §3 pricing object (no envelope) plus `request_id` (extra-work) or `lapsed_item_ids`
  (final-bill). 201 for a new request or a new bill; 200 otherwise (including the idempotent re-issue).
- **inspection/start, work/start, work/complete** are idempotent (a second call is a 200 no-op, no event). inspection/start
  and work/start are refused once a bill exists (`BILL_EXISTS`); inspection/start after work completed → `INVALID_STATE`.
- **Customer decisions** are refused once a bill exists (`BILL_EXISTS`): the bill is the record. Lapsed items do not
  change the request's status.
- **Removal items** copy qty and unit price (negative) from the quote line; the name defaults to `Remove: {line name}`.
- **Legacy payload on an inspection service** (price without `price_lines`) turns it back into a `fixed` service.
- **Payments:** the Razorpay order notes get `finalBillId` for v2 only (legacy notes are unchanged). Creating an order
  for a v2 bill that is already paid → 409 `ALREADY_PAID`. The reconciliation cron also sweeps billed, unpaid v2 bookings
  (in_progress / service_completed) and never moves them back to `confirmed`.
- **Reminders** run in the existing 10-minute cron and once at startup. Each reminder is claimed with a guarded write
  before sending, so it is sent at most once; a claimed reminder whose send fails is not retried. A bill whose payment
  already succeeded is marked but not reminded.
- **`pricing_flow`** is on the vendor booking list only, because the vendor side has no booking-detail endpoint.
- **Escrow on payment (review fix, 2026-11-21).** A v2 booking is usually completed before it is paid, so at completion
  there is no Payment row to hold. Every path that records a v2 payment (verify, webhook, reconciliation;
  `util/pricingV2Payment.js`) sets the same `payoutHoldUntil` that completion sets (`payoutHoldHours`). If the booking is
  already `service_completed`, it also restarts `service_completed_at`, so the customer gets the normal auto-confirm window
  from the moment they paid. No new durations.
- **Void race (review fix, 2026-11-21).** If a bill is voided after its Razorpay order was made, the capture is still
  recorded (the money has moved; there is no auto-refund). It is flagged with a `payment_bill_mismatch` BookingEvent and a
  `[MANUAL ACTION]` log line. The same happens when the order was made for an earlier bill that was voided and re-issued
  with the same total. If a voided bill has no replacement, the capture cannot be matched and is logged for manual review,
  as before.
- **Reminders** are only sent for bookings that can still be paid (`in_progress` / `service_completed`).

### Owner decisions 2026-11-21

- **Free inspection.** No new column: a `pricing_type: 'inspection'` service with `inspection_fee: 0` is a free
  inspection (the validator still requires the field; 0 means free). The booking snapshot then has **no** "Inspection
  fee" line (zero quote lines, total 0); `quote.inspection_fee` is `0`. The waiver never applies (no "Inspection fee
  waived" line). Service list/details keep `inspection_fee` as stored; apps show "Free inspection" for type
  `inspection` + fee 0. Each booking keeps what it was booked with.
- **₹0 final bill auto-closes.** Razorpay cannot charge ₹0, so `POST .../final-bill` with a total of exactly 0 creates the
  bill already `status: 'paid'` with `paid_at` set: no Payment row, no fee, nothing to pay out. Response is the normal
  201 pricing view with `bill.status: 'paid'`, `bill.total: 0`; `can.pay` and `can.void_bill` are false. A BookingEvent
  `final_bill_no_charge` is written and the customer gets notification type `final_bill_no_charge` ("your bill is ₹0,
  nothing to pay"). The vendor can then mark `service_completed` as usual; customer confirm and the auto-confirm cron
  close it to `user_confirmed` with no payout (`services/bookingConfirmationService.js`).
- **0 < total < ₹1 is refused.** HTTP 422
  `{ "success": false, "message": "A bill must be ₹0 or at least ₹1. Adjust the lines and try again.", "code": "BILL_TOO_SMALL" }`.
  Nothing is written (pending items are not lapsed); the garage adjusts lines and re-issues.

## 9. Photos, parts used, call customer, final-bill download, earnings (added 2026-11-21)

All errors use the usual `{success:false, message, code}` shape. Vendor routes: approved vendor, own booking, v2 only.

### Schema (additive)
One new table, no Booking column: `BookingPhoto {id, bookingId (FK, cascade), extraWorkRequestId (nullable FK, cascade), kind 'check_in'|'extra_work', url, created_by, createdAt}`
(plus virtual back-relations `Booking.bookingPhotos`, `ExtraWorkRequest.photos`). "Parts used" is a `BookingEvent` of type `parts_used`
(no table). Applied by the normal `prisma db push` on deploy.

### Job photos (G03 / G04)
`POST /service_api/vendor/bookings/:id/photos` -- `multipart/form-data`, same uploader as health sheets (Cloudinary, 20 MB per file,
JPEG/PNG/WebP only here). Fields: `photos` (1 to 10 files), `kind` (`check_in` | `extra_work`), `request_id` (required for `extra_work`).
- Needs check-in and an active booking. `extra_work`: the request must still be `pending` / `partially_approved` and no bill issued.
- Limits: 10 check-in photos per booking, 10 photos per request (409 `PHOTO_LIMIT`). Append-only (no delete).
- 201, body = the updated pricing object. Errors: 400 `VALIDATION_ERROR`, 409 `NOT_CHECKED_IN` / `INVALID_STATE` / `REQUEST_CLOSED` / `BILL_EXISTS` / `PHOTO_LIMIT` / `NOT_V2`, 404, 403.
- In the pricing object (both roles): `job.photos: [{id, url, created_at}]` (check-in) and `requests[].photos: [{id, url, created_at}]`.
  The customer's approval screen reads `requests[].photos`. Photos are uploaded AFTER the request is created (the request is JSON), so
  upload right after `POST extra-work`; both parties get `booking:pricing_updated` and refetch.

### Parts used (G06)
`POST /service_api/vendor/bookings/:id/parts-used` body `{ "note": "2 brake pads, 1 fluid" }` (1 to 300 chars, max 20 notes per booking).
Needs check-in + active booking. 201, updated pricing object with `job.parts_used: [{note, at}]` (oldest first, both roles).
Audited as BookingEvent `parts_used` payload `{note}`. 409 `NOTE_LIMIT` past 20.

### Call customer (G05)
`GET /service_api/vendor/bookings/:id/customer-contact` -> `{ "booking_id": 100, "name": "Rahul" | null, "phone": "+91..." | null }`.
Own booking, v2, `vendor_status: accepted`, not cancelled/refunded (else 409 `INVALID_STATE`; legacy 409 `NOT_V2`). This does not widen
exposure: the vendor booking list already returns the customer's `userProfile.phone` for every booking they own.

### Final bill download (U07)
1. `POST /service_api/user/bookings/:id/bill-link` (customer) or `POST /service_api/vendor/bookings/:id/bill-link` (vendor), bearer auth, no body.
   200 `{ "url": "https://<api>/bills/7/view?t=<token>", "expires_at": "ISO" }`.  (`<api>` is the optional `PUBLIC_BASE_URL` env var when set, else the request protocol/host.) 409 `BILL_NOT_ISSUED` before a bill exists (void bills never qualify), 409 `NOT_V2`.
2. Open `url` in the phone browser (`Linking.openURL`). `GET /bills/:id/view?t=...` is public (no bearer header), rate limited, returns a printable
   HTML page titled "Final bill" (Keplix branding, bill number, lines, labour/parts/total, tax-inclusive note, "not a tax invoice"). Customer copy also
   shows the platform fee and total paid when the on-top fee was paid. Token: HMAC-SHA256 with the dedicated `BILL_LINK_SECRET` env var (min 32 chars, GitHub secret passed in deploy.yml; no fallback: if missing/short the bill-link endpoints return 503 `BILL_LINK_UNAVAILABLE` and the view page 403), 15-minute expiry, bound to the bill, role and
   user; the page re-checks ownership. Bad/expired/mismatched token 403 (text), wrong owner or void bill 404. `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, own CSP.

### Earnings and settlement (G08) -- vendor, read-only, no commission
`GET /service_api/vendor/bookings/:id/earnings`:
```json
{ "booking_id": 100, "bill_number": "KPX-2026-000123", "bill_total": 5000,
  "customer_paid": 5050, "platform_fee": 50, "payout_amount": 5000,
  "payout_status": "awaiting_confirmation", "expected_payout_at": "2026-11-23T10:00:00.000Z" }
```
`payout_status`: `awaiting_payment` (customer has not paid; amounts 0), `after_completion` (paid, job not finished), `awaiting_confirmation` (service_completed;
payout at the customer's confirm or the auto-confirm window, never before the escrow hold), `on_hold` (escrow hold running), `releasing` (queued/processing),
`paid`, `failed`, `refunded` (payout 0), `not_applicable`. `expected_payout_at` is null unless the time is known. Amounts come from
Payment.amount / platformFee / vendorAmount (fallback amount minus fee); nothing new is stored. 403 for another vendor's booking.

`GET /service_api/vendor/earnings/summary?from=ISO&to=ISO` (both optional, filter on payment date):
`{ customer_paid_total, platform_fee_total, payout_paid_total, payout_pending_total, payout_failed_total, refunded_count, next_payout_at, booking_count, truncated }`
(`truncated: true` when more than 5000 payments matched and totals are partial).

### Booking list rows
The customer booking list/detail and the vendor booking list rows now also carry `bill_status` (`'issued'` | `'paid'` | `null`) and `bill_total` (rupees | `null`),
read from the open FinalBill (not a Booking column). `null` for legacy rows and v2 rows with no open bill.

Vendor booking list rows additionally carry (no new Booking columns; joined in the same query):
- `vehicle`: `{ make, model, registration, segment, fuel_type }` (each string or `null`) from the BookingVehicle snapshot + linked Vehicle, or `null` when the booking has no BookingVehicle row.
- `notes`: the customer's booking note (`Booking.notes`) as a string, or `null` when empty.
