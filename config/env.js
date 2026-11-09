import { z } from "zod";
import { trimRazorpayEnv } from "../util/razorpayCredentials.js";
import { createProxyFetch } from "../util/proxyFetch.js";

// Trim Razorpay keys before anything builds a Razorpay client: a trailing
// newline pasted into a GitHub secret turns a valid key into a 401 (the
// 2026-11-03 "payment failed with status code 502" incident). See
// util/razorpayCredentials.js.
export const trimmedRazorpayVars = trimRazorpayEnv(process.env);

// Vars that are only ever read by prisma/seed*.js, never by the running
// server. Missing them must not stop the app from booting -- they are
// validated here only so a typo shows up when a seed script actually needs
// them, not stripped by z.object() and not required at server startup.
const seedOnlyFields = {
  SEED_ADMIN_EMAIL: z.string().optional(),
  SEED_ADMIN_NAME: z.string().optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(),
  SEED_ADMIN_PHONE: z.string().optional(),
  SEED_PASSWORD: z.string().optional(),
};

// Razorpay/RazorpayX vars already have a production-only required check in
// util/payoutHelper.js (it throws at import time if any of the four core
// keys are missing under NODE_ENV=production), and every call site falls
// back to a placeholder key outside production so local/dev/test boots keep
// working without them. This schema mirrors that same production-only gate
// -- rather than making the vars unconditionally required, which would break
// the dev/test placeholder fallback that already works -- so a production
// deploy still fails fast, at startup, with every missing key named at once.
const razorpayFields = {
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  RAZORPAYX_ACCOUNT_NUMBER: z.string().optional(),
  RAZORPAYX_KEY_ID: z.string().optional(),
  RAZORPAYX_KEY_SECRET: z.string().optional(),
  // http://user:pass@host:port of the payout proxy on the n8n VM. RazorpayX
  // only accepts payout calls from allowlisted IPs (see util/proxyFetch.js).
  RAZORPAYX_PROXY_URL: z.string().optional(),
};
const REQUIRED_IN_PRODUCTION = [
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "RAZORPAYX_ACCOUNT_NUMBER",
  "RAZORPAYX_KEY_ID",
  "RAZORPAYX_KEY_SECRET",
  // Both of these have already caused a live incident from being unset in
  // production while the rest of the app booted successfully: Google login
  // 500ing (GOOGLE_ALLOWED_AUDIENCES) and password-reset links shipping
  // "undefined/reset-password/..." (FRONTEND_URL). deploy.yml already
  // interpolates both from GitHub secrets into --set-env-vars -- this only
  // fails loudly at boot if that secret was never actually set, instead of
  // failing deep inside a request handler the first time a user hits it.
  "GOOGLE_ALLOWED_AUDIENCES",
  "FRONTEND_URL",
];

// Twilio/WhatsApp: every call site (util/communication.js,
// services/walkInNotificationService.js) already checks for these and logs
// a warning + skips the send when they're absent, rather than throwing.
// That's a working graceful degradation (SMS/WhatsApp becomes a no-op, the
// rest of the app keeps running), so these stay optional here too --
// declared so they aren't stripped from `env`, not required.
const twilioFields = {
  TWILIO_ACCOUNT_SID: z.string().optional(),
  // Twilio accepts either the classic Auth Token, or an API Key SID +
  // Secret pair (still combined with TWILIO_ACCOUNT_SID above) -- see
  // util/communication.js's getTwilioClient for which one wins when both
  // are set.
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_API_KEY_SID: z.string().optional(),
  TWILIO_API_KEY_SECRET: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  TWILIO_WHATSAPP_FROM: z.string().optional(),
  TWILIO_WHATSAPP_WALKIN_TEMPLATE_SID: z.string().optional(),
};

const envSchema = z
  .object({
    PORT: z.string().optional(),

    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

    // --- Rate limiting -----------------------------------------------------
    // Previously hardcoded literals in app.js, which meant a load test could
    // only ever measure the limiter (the global budget works out at roughly
    // 1.1 req/sec) and staging could not be loosened without a code change.
    //
    // coerce.number() because every process.env value is a string; z.number()
    // alone would reject "1000". Defaults reproduce the previous behaviour
    // exactly, so an environment that sets none of these is unchanged -- except
    // AUTH_MAX, which was 20 in production and is raised to 40 now that
    // /profile and /push-token no longer share this budget.
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(1000),
    RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(40),
    RATE_LIMIT_AUTHED_MAX: z.coerce.number().int().positive().default(600),

    // Still required after the 2026-11 Supabase Auth migration: util/otp.js
    // uses it as the HMAC key for stored OTP hashes. No longer used to sign
    // or verify login tokens.
    JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),

    // Supabase Auth (2026-11 migration). util/supabaseAuth.js reads these
    // from process.env directly. The URL is public and has a built-in
    // default; the secret key is only needed for linking accounts by email,
    // email changes, erasure and scripts/importUsersToSupabase.js.
    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_SECRET_KEY: z.string().optional(),
    DATABASE_URL: z.string().url("DATABASE_URL must be a valid URL"),

    CLOUDINARY_URL: z.string().min(1, "CLOUDINARY_URL is required"),

    // No REDIS_* vars: Redis was removed entirely. Background jobs live in
    // Postgres (util/jobQueue.js) and the token blacklist is a table
    // (middleware/authMiddleware.js), so DATABASE_URL is the only datastore
    // config this app needs. Leftover REDIS_* values in the environment are
    // ignored -- z.object() strips undeclared keys -- and can be deleted.

    // "false" keeps background job dispatching out of this process. See server.js.
    // Declared here because z.object() STRIPS undeclared keys -- reading
    // env.RUN_WORKERS without this line would always be undefined.
    RUN_WORKERS: z.string().optional(),

    ...razorpayFields,
    ...twilioFields,

    // util/communication.js already warns + skips sending when this is
    // absent (Resend just never gets called) -- a working graceful
    // degradation, kept optional here to match.
    RESEND_API_KEY: z.string().optional(),

    // util/firebase.js already falls back to a local serviceAccountKey.json
    // file, and warns + disables push if neither is present -- a working
    // graceful degradation, kept optional here to match.
    FIREBASE_SERVICE_ACCOUNT_BASE64: z.string().optional(),

    // Was used by the old password-reset link in controllers/authController.js;
    // that flow moved to Supabase in the 2026-11 auth migration and no code
    // reads this any more. Still listed in REQUIRED_IN_PRODUCTION above --
    // dropping that boot requirement is left for a deliberate follow-up.
    FRONTEND_URL: z.string().optional(),

    // Security A-010 / SYS-006: comma-separated EXACT extra CORS origins
    // (e.g. a single preview deployment). Read by util/cors.js. No
    // wildcards; *.keplix.co.in is always allowed without listing it.
    ALLOWED_ORIGINS: z.string().optional(),

    // Was read by the old Google-login handler, removed in the 2026-11
    // Supabase Auth migration (Google sign-in is verified by Supabase now);
    // no code reads this any more. Still listed in REQUIRED_IN_PRODUCTION
    // above -- dropping that boot requirement is left for a follow-up.
    GOOGLE_ALLOWED_AUDIENCES: z.string().optional(),
    // services/walkInNotificationService.js already falls back to
    // 'https://keplix.co.in' when this is unset -- kept optional to match
    // that existing default.
    PUBLIC_WEB_BASE_URL: z.string().optional(),

    // Browser push for the vendor portal (util/webPush.js). Optional: without
    // the key pair the feature is off and nothing else is affected. Generate
    // with `npx web-push generate-vapid-keys`; the PUBLIC key is also set on the
    // portal as NEXT_PUBLIC_VAPID_PUBLIC_KEY.
    VAPID_PUBLIC_KEY: z.string().optional(),
    VAPID_PRIVATE_KEY: z.string().optional(),
    VAPID_SUBJECT: z.string().optional(),

    // The call site (util/communication.js)
    // already falls back to 'Keplix <noreply@keplix.co.in>' when this is
    // unset -- kept optional to preserve that existing default.
    EMAIL_FROM: z.string().optional(),

    // util/blogPublishHooks.js rebuilds keplix-website when a blog post goes
    // live or changes. Optional: unset (or empty, which is what an unset GitHub
    // secret becomes) means no automatic rebuild -- redeploy by hand instead.
    // Must also be on deploy.yml's --set-env-vars line to reach Cloud Run.
    VERCEL_DEPLOY_HOOK_URL: z.string().optional(),

    // util/bookingStatusManager.js already does
    // `process.env.BOOKING_PENDING_TIMEOUT_MINUTES || 5`. Declared here only
    // so it isn't stripped from `env` for anything that wants to read it via
    // config/env.js instead of process.env directly; the `|| 5` fallback in
    // bookingStatusManager.js is untouched and still wins when this is unset.
    BOOKING_PENDING_TIMEOUT_MINUTES: z.string().optional(),

    // services/walkInNotificationService.js already does
    // `process.env.NOTIFY_BOTH_CHANNELS !== 'false'` (defaults to true).
    // Declared so it isn't stripped; that existing default is untouched.
    NOTIFY_BOTH_CHANNELS: z.string().optional(),

    ...seedOnlyFields,
  })
  .superRefine((vars, ctx) => {
    // Mirrors util/payoutHelper.js's own production-only guard: in
    // production, fail fast at startup (naming every missing key) instead of
    // letting Razorpay calls fail deep inside a request handler, or -- worse
    // -- silently fall back to the shared 'rzp_test_placeholder' credentials
    // that every call site uses outside production.
    if (vars.NODE_ENV === "production") {
      for (const key of REQUIRED_IN_PRODUCTION) {
        if (!vars[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when NODE_ENV=production`,
          });
        }
      }
    }
    // A malformed payout proxy URL would otherwise boot fine and then fail
    // every vendor payout. Parse it here with the same code that uses it.
    const proxyUrl = vars.RAZORPAYX_PROXY_URL?.trim();
    if (proxyUrl) {
      try {
        createProxyFetch(proxyUrl);
      } catch (err) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["RAZORPAYX_PROXY_URL"], message: err.message });
      }
    }
  });

export const env = envSchema.parse(process.env);
