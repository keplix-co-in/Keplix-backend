# Keplix security assessment

Authorized penetration test of the Keplix systems (backend, both mobile apps,
admin panel, marketing website), performed at the owner's request. Static
analysis of all repositories plus **safe, non-destructive** active probing of the
live production backend. No destructive or DoS testing was run against production,
which holds real customer bookings and payment data.

**Headline: one CRITICAL data-exposure vulnerability was found live and fixed.**

---

## CRITICAL — Vendor banking PII exposed on a public endpoint  · FIXED

`GET /service_api/services/:id` is public and unauthenticated. It did
`include: { vendor: { include: { vendorProfile: true } } }` and returned the row
with `res.json({ ...service })`. That shipped the **entire** vendor and profile to
any caller.

Confirmed live against production (`svc 1313`), the response contained:

```
bank_account_number  "AADF2456"
ifsc_code            "SDDGY4GUH"
upi_id               "987654@@glb"
bank_account_holder_name "Adfg"
email                mickeygamer19025@gma…
password             ""        (empty for Google-auth vendors; a bcrypt hash
                                would have leaked for password vendors)
```
plus phone, alternate_phone, date_of_birth, GST number and full address.

**Impact.** Anyone on the internet could enumerate sequential service IDs and
harvest every vendor's bank account number, IFSC and UPI ID — everything needed
to target them for payment fraud or social-engineering. No auth, no rate context
beyond the global limiter. This is the most serious class of finding: bulk PII
disclosure of financial data.

**Same leak, other endpoints** (also fixed): `getServicesByVendor` (public),
the paginated services list, and the customer's own `getUserBookings` /
`getSingleBooking` (which leaked the vendor's bank details to every customer).

**Fix.** New `util/publicVendor.js`:
- `stripVendorSecrets()` — recursively removes `password`, `bank_account_number`,
  `ifsc_code`, `upi_id`, `bank_account_holder_name`, `fcmToken`, `pushToken`,
  `date_of_birth`, `gst_number`, `otp` from any object about to be returned.
- `PUBLIC_VENDOR_PROFILE_SELECT` / `PUBLIC_VENDOR_INCLUDE` — a strict allow-list
  Prisma fragment so the columns are never fetched in the first place (defence in
  depth for new code).

Every affected `res.json` now routes through `stripVendorSecrets`. Regression
suite `tests/regressions/vendorPiiLeak.test.js` locks it in (5 tests). New columns
added to the schema are private by default.

**Recommended follow-up.** Move the affected queries to explicit Prisma `select`
so the secret columns never leave the database, and retire the broad `include`.
The serializer is the safety net; not fetching the data is the real fix.

---

## Live probes that PASSED (no vulnerability)

The auth and payment boundary is genuinely well-built. Verified against production:

| Attack | Result |
|---|---|
| JWT `alg:none` forgery | 401 rejected |
| JWT garbage / tampered signature | 401 rejected |
| JWT signed with weak secret `"secret"` | 401 rejected |
| Money-out endpoints (`refund`, `settle`, `force-complete`) unauth | 401 rejected |
| Razorpay webhook, no signature | 400 "Invalid signature" |
| Razorpay webhook, forged body | 400 rejected |
| Admin endpoints (`users`, `vendors`, `finance/*`) unauth | 401 rejected |
| CORS with `Origin: evil-attacker.com` | not reflected |
| Public job-sheet token guessing | 404 (opaque) |
| SQL injection surface | none — every `$queryRaw` is a parameterised tagged template; no `queryRawUnsafe` anywhere |
| Command injection | none — no `child_process`/`exec`/`eval`; only regex `.exec()` |
| Secrets committed to source | none across all four repos; only `.env.example` tracked |
| User-enumeration on login | none — identical message for unknown vs wrong password (from earlier assessment) |

---

## Lower-severity findings

### MEDIUM — Admin token in `localStorage`
`kepix-admin/src/services/authApi.js` stores `adminToken` / `adminRefreshToken` in
`localStorage`, readable by any JavaScript that runs on the page — so an XSS on the
admin panel yields full admin session theft. This is the standard SPA trade-off and
is largely mitigated by the strict CSP and the absence of an XSS vector (see below),
but an httpOnly, SameSite refresh cookie would remove the class entirely for the
long-lived token.

### LOW — `SELECT *` pulls PII into memory in the location search · FIXED
`searchVendorsByLocation` ran `SELECT * FROM "VendorProfile"`, loading bank columns
into memory even though the response mapped only safe fields. Changed to an explicit
column list (`"userId"`, `business_name`, `address`, `latitude`, `longitude`, plus the
computed `distance`) — the sensitive columns are now never fetched.

### INFO — Vendor payment amount is client-supplied
Carried over from the API assessment: `createVendorPaymentOrder` takes `amount`
from the body (now validated for range, but still client-chosen). Verify is safe
(reads the gateway's authoritative amount), so recorded revenue cannot be faked,
but a vendor can create an order for less than the intended plan price. Needs a
server-side plans table.

### INFO — No `package-lock.json` on the backend · FIXED (and see below)
Generated with `npm install --package-lock-only`. `npm audit` now runs.

### Dependency vulnerabilities · FIXED (production runtime clean of critical + high)

The first audit reported **53 vulnerabilities (2 critical, 26 high)**. Remediated
by targeted within-major bumps and pinned `overrides` in `package.json` — never
`npm audit fix --force`, whose only offer was breaking/counterproductive bumps
(including a *downgrade* of prisma to 6.19.3). Each change was verified against the
full test suite (484) and a boot check.

**Result — the deployed production runtime (`npm audit --omit=dev`) is now clean of
every critical and high advisory: 0 critical, 0 high** (down from 2 critical / ~14
high). 12 moderate + 2 low remain in production, all DoS-class in deep transitives
(`qs`, `uuid`) whose only fixes are breaking major bumps not justified by the risk.

The full tree (dev + prod) went 53 → 25. The remaining highs are **exclusively in
devDependencies** — `jest` and the `prisma` CLI (js-yaml, minimatch, picomatch,
mysql2, etc.). These never execute in the deployed server; forcing their major bumps
would break the test runner and migration CLI for zero production benefit, so they
are deliberately left.

Fixes applied:
- **Criticals:** `ws >=8.21.3`, `websocket-driver >=0.7.5`, `engine.io >=6.6.10`
  (Socket.IO chat stack); `protobufjs ~7.6.6` (arbitrary code execution, pinned to
  7.6.x so gRPC/firebase-admin is undisturbed).
- **Production highs:** `axios >=1.20.0` (razorpay), `lodash >=4.18.1` (cloudinary),
  `fast-xml-parser >=5.11.1` + `form-data >=4.0.6` (firebase-admin),
  `path-to-regexp 0.1.13` (express 4 router, pinned to 0.1.x),
  `@grpc/grpc-js >=1.14.4`, `socket.io-parser >=4.2.7`.
- **swagger-jsdoc subtree** (scoped override so jest's copies are untouched):
  `brace-expansion 1.1.18`, `js-yaml 4.3.2`.
- **Direct bumps:** `express-rate-limit ^8.7.0`, `firebase-admin ^13.10.0`,
  `@prisma/client`/`prisma ^7.10.0`, `morgan ^1.12.0`.

Lockfile committed so `npm audit` runs in CI going forward.

Remaining follow-up (own effort, not blocking): the dev-tooling highs behind a
jest/babel major upgrade, and the production `qs`/`uuid` moderates when their
non-breaking fixes land.

---

## Frontend / website — reviewed, clean

- The only `dangerouslySetInnerHTML` (blog article body, `keplix-website`) is
  DOMPurify-sanitised client-side **and** re-sanitised server-side on write
  (`util/sanitizeHtml.js`) — defence in depth.
- Strict CSP in `vercel.json`: `X-Frame-Options: DENY`, `frame-ancestors 'none'`,
  HSTS, `nosniff`. Report-only CSP allows only the expected hosts.
- No secrets baked into any client bundle (checked Expo `EXPO_PUBLIC_*` and Vite
  `VITE_*` exposure). The only public value is the Razorpay **key id**, which is
  public by design.

---

## Scope and method

- **Static analysis:** all four repos — injection, auth, IDOR, secrets, data
  over-exposure, XSS, insecure storage.
- **Live active probing:** production backend only, non-destructive. Auth forgery,
  privilege boundaries, webhook forgery, CORS, PII disclosure, injection response
  probes.
- **Not performed:** destructive writes, DoS / rate-limit exhaustion, and any
  testing of third parties (Razorpay, Supabase, Cloudinary, Google, Twilio). The
  full intrusive workflow-abuse suite is ready to run once a disposable test
  database exists — see `docs/API-TEST-REPORT.md`.

Backend suite green at **484 tests / 33 suites** with the fix and its regression
guard in place; app boots clean.
