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

const accessToken = jwt.sign({ id: 1, type: 'access', exp: ACCESS_EXP }, 'test-secret-for-logout-spec');
const refreshTok = jwt.sign({ id: 1, type: 'refresh', exp: REFRESH_EXP }, 'test-refresh-secret-for-logout-spec');

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

  it('still returns 400 when the access token is missing', async () => {
    const res = makeRes();
    await logoutUser({ headers: {}, body: { refresh: refreshTok } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(blacklistToken).not.toHaveBeenCalled();
  });
});
