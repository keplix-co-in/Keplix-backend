import rateLimit from 'express-rate-limit';

// Strict limiter for sensitive auth actions: max 3 attempts per 2 hours per IP
export const strictAuthLimiter = rateLimit({
  windowMs: 2 * 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please try again after 2 hours.' }
});

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
