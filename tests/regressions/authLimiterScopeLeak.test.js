/**
 * Regression test: authLimiter (the tight, credential-endpoint budget) must
 * not also throttle the `protect`-guarded, authedReadLimiter-budgeted routes
 * that happen to live under the same /accounts/auth prefix (profile,
 * push-token, web-push, export, account, password/change).
 *
 * app.js used to mount authLimiter on the WHOLE router:
 *   app.use("/accounts/auth", authLimiter, authRoutes);
 * That runs before routes/auth.js's own `protect` middleware, so
 * keyByUserOrIp (middleware/rateLimitMiddleware.js) never sees req.user and
 * falls back to IP for every request under this prefix -- including the ones
 * routes/auth.js explicitly puts on the generous, per-user authedReadLimiter.
 * The result: reading your own profile a handful of times, or one login plus
 * a few ordinary authenticated calls, silently spent the SAME 20-requests/
 * 15-min IP budget meant only for brute-force-sensitive routes -- exactly the
 * "~20 profile views locks out login for the whole IP" bug that
 * authedReadLimiter's per-route carve-out (see comments above GET /profile in
 * routes/auth.js) was written to fix. Found by the auth audit flow test
 * (tests/audit/auth.flow.mjs, 2026-09-28): a normal login + profile +
 * push-token + web-push + export + erase sequence from one client hit 429
 * well before any brute-force threshold.
 *
 * Fix: authLimiter is now applied per-route in routes/auth.js on the
 * credential-accepting endpoints only (register, login, google, OTP send/
 * verify, password reset); app.js no longer mounts it on the whole router.
 *
 * This test pins that: with a deliberately tiny authLimiter budget, repeated
 * calls to a `protect`-guarded read route must NOT trip it, while repeated
 * calls to a credential route (login) still do.
 */
import { jest } from '@jest/globals';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-limiter-scope-spec';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-for-limiter-scope-spec';
// Tiny credential budget so the test can exceed it in a handful of requests;
// a generous authed-read budget so the fixed behavior is unambiguous.
process.env.RATE_LIMIT_AUTH_MAX = '2';
process.env.RATE_LIMIT_AUTHED_MAX = '50';
process.env.RATE_LIMIT_MAX = '1000';
process.env.RATE_LIMIT_WINDOW_MS = String(15 * 60 * 1000);

jest.unstable_mockModule('../../middleware/authMiddleware.js', () => ({
  blacklistToken: jest.fn().mockResolvedValue(undefined),
  isRefreshTokenBlacklisted: jest.fn().mockResolvedValue(false),
  isTokenBlacklisted: jest.fn().mockResolvedValue(false),
  invalidateUserCache: jest.fn(),
  // Stand in for the real middleware: always authenticates as user 1, so this
  // test exercises only the rate-limiter wiring, not DB-backed auth.
  protect: (req, res, next) => {
    req.user = { id: 1, email: 'user@test.local', role: 'user' };
    next();
  },
}));

jest.unstable_mockModule('../../controllers/authController.js', () => ({
  registerUser: (req, res) => res.status(201).json({ success: true }),
  authUser: (req, res) => res.status(401).json({ message: 'Invalid email or password' }),
  getUserProfile: (req, res) => res.json({ id: req.user.id }),
  updateUserProfileAuth: (req, res) => res.json({ id: req.user.id }),
  refreshToken: (req, res) => res.status(400).json({ message: 'Refresh token required' }),
  logoutUser: (req, res) => res.json({ message: 'Logged out successfully' }),
  forgotPassword: (req, res) => res.status(410).json({}),
  resetPassword: (req, res) => res.status(410).json({}),
  sendPasswordResetOTP: (req, res) => res.json({ success: true }),
  resetPasswordWithOTP: (req, res) => res.json({ success: true }),
  sendPhoneOTP: (req, res) => res.json({ status: true }),
  verifyPhoneOTP: (req, res) => res.json({ status: true }),
  sendEmailOTP: (req, res) => res.json({ success: true }),
  verifyEmailOTP: (req, res) => res.json({ success: true }),
  googleLogin: (req, res) => res.status(401).json({ message: 'Invalid token' }),
  updatePushToken: (req, res) => res.json({ success: true, message: 'Push token updated' }),
  registerWebPush: (req, res) => res.json({ success: true }),
  unregisterWebPush: (req, res) => res.json({ success: true }),
  changePassword: (req, res) => res.json({ message: 'Password changed successfully' }),
  deleteAccount: (req, res) => res.json({ message: 'Account deactivated and personal data erased.' }),
  exportAccountData: (req, res) => res.json({ ok: true }),
}));

jest.unstable_mockModule('../../middleware/validationMiddleware.js', () => ({
  validateRequest: () => (req, res, next) => next(),
}));

jest.unstable_mockModule('../../middleware/uploadMiddleware.js', () => ({
  uploadFieldss: () => (req, res, next) => next(),
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const { default: authRoutes, logoutRouter } = await import('../../routes/auth.js');

// Mounted the way app.js mounts it TODAY (no authLimiter on the whole router).
const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/accounts/auth', authRoutes);
  app.use('/accounts/auth', logoutRouter);
  return app;
};

describe('authLimiter does not leak onto authedReadLimiter routes', () => {
  it('repeated calls to a protect-guarded read route are not throttled by the credential budget', async () => {
    const app = buildApp();
    const results = [];
    // One more than RATE_LIMIT_AUTH_MAX (2): if authLimiter were still mounted
    // on the whole router, the 3rd+ of these would 429 with "Too many
    // authentication attempts".
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/accounts/auth/profile').set('Authorization', 'Bearer x');
      results.push(res.status);
    }
    expect(results).toEqual([200, 200, 200, 200, 200]);
  });

  it('repeated calls to push-token (another authedReadLimiter route) are not throttled either', async () => {
    const app = buildApp();
    const results = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .put('/accounts/auth/push-token')
        .set('Authorization', 'Bearer x')
        .send({ pushToken: 'x' });
      results.push(res.status);
    }
    expect(results).toEqual([200, 200, 200, 200, 200]);
  });

  it('the credential budget still applies to login itself', async () => {
    const app = buildApp();
    const results = [];
    // RATE_LIMIT_AUTH_MAX is 2 -- the 3rd login attempt must 429.
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/accounts/auth/login')
        .send({ email: 'a@b.com', password: 'x' });
      results.push(res.status);
    }
    expect(results[0]).toBe(401);
    expect(results[1]).toBe(401);
    expect(results[2]).toBe(429);
    expect(results[2]).toBeDefined();
  });
});
