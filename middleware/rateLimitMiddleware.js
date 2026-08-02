import rateLimit from 'express-rate-limit';

// Strict limiter for sensitive auth actions: max 3 attempts per 2 hours per IP
export const strictAuthLimiter = rateLimit({
  windowMs: 2 * 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please try again after 2 hours.' }
});
