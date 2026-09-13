import { z } from "zod";

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

    JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),

    // authController.js already falls back to JWT_SECRET when this is unset
    // (with a console.warn) outside of throwing itself when it's missing, so
    // it stays optional here to avoid duplicating/contradicting that
    // existing runtime check.
    JWT_REFRESH_SECRET: z.string().optional(),

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

    // Used directly in controllers/authController.js to build the
    // password-reset link with no fallback -- an unset value silently ships
    // "undefined/reset-password/..." to a user's inbox. Required in
    // production via REQUIRED_IN_PRODUCTION above; stays optional at the
    // schema level (not required in dev/test) since local .env commonly
    // omits it and that's a fine default outside production.
    FRONTEND_URL: z.string().optional(),

    // Read directly via process.env in controllers/authController.js's
    // Google-login handler (not through this `env` object), but declared
    // here too so REQUIRED_IN_PRODUCTION's production check can see it and
    // fail boot loudly instead of every Google login 500ing at request time
    // -- the exact incident TODO.md records this var having caused already.
    GOOGLE_ALLOWED_AUDIENCES: z.string().optional(),

    // services/walkInNotificationService.js already falls back to
    // 'https://keplix.co.in' when this is unset -- kept optional to match
    // that existing default.
    PUBLIC_WEB_BASE_URL: z.string().optional(),

    // Every call site (controllers/authController.js, util/communication.js)
    // already falls back to 'Keplix <noreply@keplix.co.in>' when this is
    // unset -- kept optional to preserve that existing default.
    EMAIL_FROM: z.string().optional(),

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
  });

export const env = envSchema.parse(process.env);
