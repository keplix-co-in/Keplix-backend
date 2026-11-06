/**
 * Regression test: POST /accounts/auth/logout must revoke the refresh token.
 *
 * logoutUser blacklisted only the access token from the Authorization header.
 * Refresh tokens live 30 days, so a "logged out" client (or anyone who had
 * captured its refresh token) could keep minting access tokens for a month.
 * The handler now blacklists an optional `refresh` from the body through the
 * same blacklistToken helper the rotation path in refreshToken() uses.
 *
 * Backward compatibility is part of the contract, not a nicety: shipped mobile
 * builds don't send the field and can't be updated in place, so a missing or
 * malformed refresh token must still yield a 200.
 *
 * See tests/regressions/jwtTypeConfusion.test.js for the file convention.
 */
import { jest } from '@jest/globals';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-logout-spec';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-for-logout-spec';

const blacklistToken = jest.fn().mockResolvedValue(undefined);

jest.unstable_mockModule('../../middleware/authMiddleware.js', () => ({
  blacklistToken,
  isRefreshTokenBlacklisted: jest.fn().mockResolvedValue(false),
  isTokenBlacklisted: jest.fn().mockResolvedValue(false),
  protect: jest.fn(),
  invalidateUserCache: jest.fn(),
}));

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    user: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
    blacklistedToken: { findUnique: jest.fn(), upsert: jest.fn() },
  },
}));

const jwt = (await import('jsonwebtoken')).default;
const { logoutUser } = await import('../../controllers/authController.js');

const ACCESS_EXP = Math.floor(Date.now() / 1000) + 3600;
const REFRESH_EXP = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;

// Security A-007: logout now VERIFIES these, so they must be signed with the
// secrets the controller actually reads (.env may already define them).
const accessToken = jwt.sign({ id: 1, type: 'access', exp: ACCESS_EXP }, process.env.JWT_SECRET);
const refreshTok = jwt.sign({ id: 1, type: 'refresh', exp: REFRESH_EXP }, process.env.JWT_REFRESH_SECRET);

const makeRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const makeReq = (body) => ({
  headers: { authorization: `Bearer ${accessToken}` },
  body,
});

describe('logoutUser refresh-token revocation', () => {
  beforeEach(() => blacklistToken.mockClear());

  it('blacklists both the access token and the supplied refresh token', async () => {
    const res = makeRes();
    await logoutUser(makeReq({ refresh: refreshTok }), res);

    expect(blacklistToken).toHaveBeenCalledWith(accessToken, ACCESS_EXP);
    expect(blacklistToken).toHaveBeenCalledWith(refreshTok, REFRESH_EXP);
    expect(blacklistToken).toHaveBeenCalledTimes(2);
    expect(res.json).toHaveBeenCalledWith({ message: 'Logged out successfully' });
    expect(res.status).not.toHaveBeenCalledWith(500);
  });

  it('still logs out when no refresh token is sent (old clients)', async () => {
    const res = makeRes();
    await logoutUser(makeReq({}), res);

    expect(blacklistToken).toHaveBeenCalledTimes(1);
    expect(blacklistToken).toHaveBeenCalledWith(accessToken, ACCESS_EXP);
    expect(res.json).toHaveBeenCalledWith({ message: 'Logged out successfully' });
  });

  it('still logs out when the body is absent entirely', async () => {
    const res = makeRes();
    await logoutUser({ headers: { authorization: `Bearer ${accessToken}` } }, res);

    expect(blacklistToken).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ message: 'Logged out successfully' });
  });

  it('still logs out when the refresh token is malformed or not a string', async () => {
    for (const refresh of ['not-a-jwt', '', 12345, { nope: true }, null]) {
      blacklistToken.mockClear();
      const res = makeRes();
      await logoutUser(makeReq({ refresh }), res);

      expect(blacklistToken).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledWith({ message: 'Logged out successfully' });
    }
  });

  it('Security A-007: a forged/garbage bearer is a 401, not a 500, and writes no row', async () => {
    for (const bad of ['not-a-jwt', jwt.sign({ id: 1, type: 'access', exp: 9999999999 }, 'attacker-key')]) {
      blacklistToken.mockClear();
      const res = makeRes();
      await logoutUser({ headers: { authorization: `Bearer ${bad}` }, body: {} }, res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(blacklistToken).not.toHaveBeenCalled();
    }
  });

  it('Security A-007: an already-expired but genuine token still logs out', async () => {
    const expired = jwt.sign({ id: 1, type: 'access', exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET);
    const res = makeRes();
    await logoutUser({ headers: { authorization: `Bearer ${expired}` }, body: {} }, res);
    expect(res.json).toHaveBeenCalledWith({ message: 'Logged out successfully' });
  });

  it('Security A-007: a refresh token for another user, or a forged one, is not blacklisted', async () => {
    const other = jwt.sign({ id: 2, type: 'refresh', exp: REFRESH_EXP }, process.env.JWT_REFRESH_SECRET);
    const forged = jwt.sign({ id: 1, type: 'refresh', exp: REFRESH_EXP }, 'attacker-key');
    for (const refresh of [other, forged]) {
      blacklistToken.mockClear();
      const res = makeRes();
      await logoutUser(makeReq({ refresh }), res);
      expect(blacklistToken).toHaveBeenCalledTimes(1);
      expect(blacklistToken).toHaveBeenCalledWith(accessToken, ACCESS_EXP);
    }
  });

  // Review fix: logout drops only the sockets opened with the revoked token,
  // not the user's other signed-in devices.
  it('Security SYS-002: disconnects only the sockets opened with the logged-out token', async () => {
    const { tokenRoom } = await import('../../util/socketSessions.js');
    const disconnectSockets = jest.fn();
    const io = { in: jest.fn(() => ({ disconnectSockets })) };
    const res = makeRes();
    await logoutUser({ ...makeReq({}), app: { get: (k) => (k === 'io' ? io : undefined) } }, res);
    expect(io.in).toHaveBeenCalledTimes(1);
    expect(io.in).toHaveBeenCalledWith(tokenRoom(accessToken));
    expect(io.in).not.toHaveBeenCalledWith(['session_1', 'user_1', 'vendor_1']);
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });

  it('still returns 400 when the access token is missing', async () => {
    const res = makeRes();
    await logoutUser({ headers: {}, body: { refresh: refreshTok } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(blacklistToken).not.toHaveBeenCalled();
  });
});
