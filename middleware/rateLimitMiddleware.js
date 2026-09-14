import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { env } from '../config/env.js';

// --- RATE LIMITERS ---
//
// Key on the authenticated user when we have one, and only fall back to IP for
// anonymous traffic.
//
// This matters more than it looks. express-rate-limit's default key is req.ip,
// and with `trust proxy` that resolves to the client's public NAT address. Mobile
// carriers put thousands of subscribers behind one CGNAT address, so an IP-keyed
// budget is shared by every user on that network -- one person opening their
// profile a few times could lock out login for everyone else on the same carrier.
// Reported as "rate limiting hits too fast", and this was the cause.
//
// Anonymous requests stay IP-keyed, which is correct: login and password reset
// have no user to key on, and IP is exactly the right axis for brute-force
// protection there.
//
// IMPORTANT: req.user is only populated by `protect`, so this only produces a
// per-user key when the limiter is mounted AFTER protect in the chain (see
// routes/auth.js). Mounted before it, or on anonymous routes, it correctly falls
// back to IP.
//
// ipKeyGenerator() rather than raw req.ip: express-rate-limit v7+ requires it in
// custom key generators so IPv6 addresses are normalised to a /64 subnet. Using
// req.ip directly lets a single IPv6 client rotate through addresses in its own
// prefix and bypass the limit entirely.
const keyByUserOrIp = (req) => {
  const id = req.user?.id;
  return id ? `u:${id}` : `ip:${ipKeyGenerator(req.ip)}`;
};

export const limiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUserOrIp,
  message: { message: "Too many requests, please try again later." }
});

// Credential endpoints only -- login, register, password reset, OTP, Google.
// Deliberately tight, because this is the brute-force surface.
//
// It used to guard everything under /accounts/auth, which swept in GET/PUT
// /profile and PUT /push-token. Those are `protect`-guarded ordinary endpoints
// that both apps call on every screen focus and every launch, so roughly twenty
// profile views spent the entire login budget for that IP. They now sit on
// authedReadLimiter below.
export const authLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_AUTH_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUserOrIp,
  message: { message: "Too many authentication attempts, please try again in a few minutes." },
  skip: (req) => req.path.includes('/logout') || req.path.includes('/token/refresh')
});

// Authenticated, non-credential endpoints that happen to live under
// /accounts/auth for historical reasons. Generous, and per-user rather than
// per-IP, because reading your own profile is not an attack.
export const authedReadLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_AUTHED_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUserOrIp,
  message: { message: "Too many requests, please try again later." }
});



// strictAuthLimiter (3 attempts / 2 hours) was REMOVED on 2026-08-19 by
// request. It had been applied to login, register, google login, forgot/reset
// password and OTP sends.
//
// It was unusable in production for a reason unrelated to its limits: it keyed
// on req.ip while `trust proxy` was unset, so behind Cloud Run every request
// resolved to the same proxy address and its three attempts were shared by
// every user of both apps. `trust proxy` is now set in app.js, which fixes the
// keying for the limiters that remain (the global 1000/15min limiter and
// authLimiter at 20/15min on /accounts/auth).
//
// What is no longer protected: password guessing and OTP-send abuse are now
// bounded only by authLimiter's 20 requests/15min per IP. That is a real
// reduction in brute-force and SMS/email-cost protection -- reinstating a
// strict per-route limiter (correctly keyed, with a saner window) is the
// recommended fix if abuse shows up.

// Public, unauthenticated job-sheet lookup by token — makes brute-forcing a
// valid token materially slower without affecting a real customer, who looks
// up one link once.
export const publicJobLookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please try again shortly.' }
});

// Per-IP backstop on My Garage phone claiming. The controller adds a
// separate per-phone throttle on top of this (see garageController.js) —
// this limiter alone would not stop someone spraying many different phone
// numbers from one IP.
export const claimRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please try again in an hour.' }
});
