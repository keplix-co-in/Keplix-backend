import rateLimit from 'express-rate-limit';

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
