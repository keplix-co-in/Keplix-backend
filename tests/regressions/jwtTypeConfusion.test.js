/**
 * Regression tests for the CONFIRMED cross-table JWT confusion defect found
 * by the 2026-09-12 codebase audit (security-auditor F1/F2, corroborated by
 * penetration-tester and test-automator).
 *
 * `User` and `Admin` are separate tables, each with an autoincrement `id`
 * starting at 1, so the two id spaces overlap. Both token families were
 * signed with the same JWT_SECRET, and neither `protect` (authMiddleware.js)
 * nor `authAdmin` (authAdminMiddleware.js) checked any claim distinguishing
 * them. Result: a customer's ordinary 1-day access token authenticated as
 * an admin whenever `User.id === Admin.id`, and vice versa — full admin
 * takeover, or arbitrary user impersonation, with a token that was never
 * meant to touch that route at all.
 *
 * The fix: both token-issuing functions now stamp a `type` claim
 * (`'access'` for users, `'admin_access'` for admins), and both middlewares
 * reject a token whose `type` doesn't match before ever looking the id up in
 * the other table. This file proves that check is in place and stays there.
 *
 * See tests/regressions/bookingStatusGuards.test.js for the file convention.
 */
import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-jwt-type-confusion-spec';
const JWT_SECRET = process.env.JWT_SECRET;

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    blacklistedToken: { findUnique: jest.fn().mockResolvedValue(null) },
    user: { findUnique: jest.fn() },
    admin: { findUnique: jest.fn() },
  },
}));

const prisma = (await import('../../util/prisma.js')).default;
const { protect } = await import('../../middleware/authMiddleware.js');
const { authAdmin } = await import('../../middleware/authAdminMiddleware.js');

// Both tables have a row at id 1 — this is the exact collision the bug relied on.
const COLLIDING_ID = 1;

const USER_ROW = {
  id: COLLIDING_ID,
  is_active: true,
  is_verified: true,
  userProfile: { id: 10 },
  vendorProfile: null,
};
const ADMIN_ROW = { id: COLLIDING_ID, role: 'admin', status: 'ACTIVE' };

const mockReq = (token) => ({
  headers: token ? { authorization: `Bearer ${token}` } : {},
});
const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  prisma.blacklistedToken.findUnique.mockResolvedValue(null);
});

describe('cross-table JWT confusion — FIXED, regression guard', () => {
  test('a customer access token is rejected by authAdmin, even when User.id collides with an existing Admin.id', async () => {
    const userAccessToken = jwt.sign({ id: COLLIDING_ID, type: 'access' }, JWT_SECRET, { expiresIn: '1d' });
    prisma.admin.findUnique.mockResolvedValue(ADMIN_ROW); // the collision: this row exists

    const req = mockReq(userAccessToken);
    const res = mockRes();
    const next = jest.fn();

    await authAdmin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(prisma.admin.findUnique).not.toHaveBeenCalled(); // rejected before the DB lookup that would have "confirmed" the admin
  });

  test('an admin access token is rejected by protect, even when Admin.id collides with an existing User.id', async () => {
    const adminAccessToken = jwt.sign(
      { id: COLLIDING_ID, role: 'admin', type: 'admin_access' },
      JWT_SECRET,
      { expiresIn: '15m' }
    );
    prisma.user.findUnique.mockResolvedValue(USER_ROW); // the collision: this row exists

    const req = mockReq(adminAccessToken);
    const res = mockRes();
    const next = jest.fn();

    await protect(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  test('a 30-day refresh token is rejected by protect, not accepted as a 1-day access token', async () => {
    const refreshToken = jwt.sign({ id: COLLIDING_ID, type: 'refresh' }, JWT_SECRET, { expiresIn: '30d' });
    prisma.user.findUnique.mockResolvedValue(USER_ROW);

    const req = mockReq(refreshToken);
    const res = mockRes();
    const next = jest.fn();

    await protect(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('sanity check: a genuine user access token still passes protect', async () => {
    const userAccessToken = jwt.sign({ id: COLLIDING_ID, type: 'access' }, JWT_SECRET, { expiresIn: '1d' });
    prisma.user.findUnique.mockResolvedValue(USER_ROW);

    const req = mockReq(userAccessToken);
    const res = mockRes();
    const next = jest.fn();

    await protect(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(401);
  });

  test('sanity check: a genuine admin access token still passes authAdmin', async () => {
    const adminAccessToken = jwt.sign(
      { id: COLLIDING_ID, role: 'admin', type: 'admin_access' },
      JWT_SECRET,
      { expiresIn: '15m' }
    );
    prisma.admin.findUnique.mockResolvedValue(ADMIN_ROW);

    const req = mockReq(adminAccessToken);
    const res = mockRes();
    const next = jest.fn();

    await authAdmin(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(401);
  });
});
