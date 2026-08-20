import { jest } from '@jest/globals';

process.env.JWT_SECRET = 'test_access_secret';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// No Redis mock anywhere in this file. Redis was removed from the app: the
// token blacklist is now the BlacklistedToken table and the 60-second user
// cache is gone entirely, so `protect` reads the user from Postgres on every
// request. Everything this middleware touches is therefore on the prisma mock.
const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  blacklistedToken: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
};

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: mockPrisma,
}));

const mockVerify = jest.fn();
jest.unstable_mockModule('jsonwebtoken', () => ({
  default: {
    verify: (...args) => mockVerify(...args),
  },
}));

// ─── Lazy imports (after mocks are registered) ────────────────────────────────

const { protect, blacklistToken, isRefreshTokenBlacklisted, invalidateUserCache } =
  await import('../../middleware/authMiddleware.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockReq(token) {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const USER_ROW = {
  id: 1,
  is_active: true,
  is_verified: true,
  userProfile: { id: 10 },
  vendorProfile: null,
};

/** Default: token is not blacklisted. */
function notBlacklisted() {
  mockPrisma.blacklistedToken.findUnique.mockResolvedValue(null);
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── No / malformed token ─────────────────────────────────────────────────────

describe('protect - missing or malformed token', () => {
  test('rejects when no authorization header is present', async () => {
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await protect(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Not authorized, no token' });
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects when authorization header does not start with Bearer', async () => {
    const req = { headers: { authorization: 'Basic abc123' } };
    const res = mockRes();
    const next = jest.fn();

    await protect(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects when jwt.verify throws (invalid/expired token)', async () => {
    notBlacklisted();
    mockVerify.mockImplementation(() => {
      throw new Error('jwt malformed');
    });

    const req = mockReq('bad.token');
    const res = mockRes();
    const next = jest.fn();

    await protect(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Not authorized, token failed' });
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── Blacklist, now in Postgres ───────────────────────────────────────────────

describe('protect - blacklisted token', () => {
  test('rejects a blacklisted token before touching the user table', async () => {
    mockPrisma.blacklistedToken.findUnique.mockResolvedValue({ id: 7 });

    const req = mockReq('blacklisted');
    const res = mockRes();
    const next = jest.fn();

    await protect(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Token has been logged out' });
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test('looks the token up by its exact value', async () => {
    notBlacklisted();
    mockVerify.mockReturnValue({ id: 1 });
    mockPrisma.user.findUnique.mockResolvedValue(USER_ROW);

    await protect(mockReq('some.jwt.value'), mockRes(), jest.fn());

    expect(mockPrisma.blacklistedToken.findUnique).toHaveBeenCalledWith({
      where: { token: 'some.jwt.value' },
      select: { id: true },
    });
  });

  // An unrecognised error means the query may well have run — a revoked token
  // must not slip through on ambiguity.
  test('fails closed when the blacklist lookup errors for an unknown reason', async () => {
    mockPrisma.blacklistedToken.findUnique.mockRejectedValue(new Error('db down'));
    mockVerify.mockReturnValue({ id: 1 });

    await protect(mockReq('some.jwt.value'), mockRes(), jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  // The regression this guards against: the BlacklistedToken table did not
  // exist in the deployed databases, every lookup threw P2021, and the old
  // blanket fail-closed turned that into "Token has been logged out" on every
  // authenticated request in both apps. Rejecting everyone is a worse outcome
  // than not enforcing logout during an outage.
  test.each([
    ['P2021', 'table does not exist'],
    ['P1001', 'cannot reach database'],
    ['P1002', 'connection timed out'],
    ['P1017', 'server closed the connection'],
  ])('fails OPEN when the blacklist query cannot run (%s)', async (code) => {
    const err = new Error('infra');
    err.code = code;
    mockPrisma.blacklistedToken.findUnique.mockRejectedValue(err);
    mockVerify.mockReturnValue({ id: 1 });
    mockPrisma.user.findUnique.mockResolvedValue(USER_ROW);

    const req = mockReq('valid.token');
    const res = mockRes();
    const next = jest.fn();

    await protect(req, res, next);

    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(req.user).toEqual(USER_ROW);
    expect(next).toHaveBeenCalled();
  });
});

// ─── User lookup (no cache any more) ──────────────────────────────────────────

describe('protect - user lookup', () => {
  test('reads the user from the database and attaches it to the request', async () => {
    notBlacklisted();
    mockVerify.mockReturnValue({ id: 1 });
    mockPrisma.user.findUnique.mockResolvedValue(USER_ROW);

    const req = mockReq('valid.token');
    const next = jest.fn();

    await protect(req, mockRes(), next);

    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      include: { userProfile: true, vendorProfile: true },
    });
    expect(req.user).toEqual(USER_ROW);
    expect(next).toHaveBeenCalled();
  });

  test('queries the database on every request, since there is no cache to hit', async () => {
    notBlacklisted();
    mockVerify.mockReturnValue({ id: 1 });
    mockPrisma.user.findUnique.mockResolvedValue(USER_ROW);

    await protect(mockReq('valid.token'), mockRes(), jest.fn());
    await protect(mockReq('valid.token'), mockRes(), jest.fn());

    expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(2);
  });

  test('rejects when the user id in the token has no row', async () => {
    notBlacklisted();
    mockVerify.mockReturnValue({ id: 999 });
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const res = mockRes();
    const next = jest.fn();

    await protect(mockReq('valid.token'), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── Account state checks (inactive / unverified) ─────────────────────────────

describe('protect - account state checks', () => {
  test('rejects an inactive account', async () => {
    notBlacklisted();
    mockVerify.mockReturnValue({ id: 1 });
    mockPrisma.user.findUnique.mockResolvedValue({ ...USER_ROW, is_active: false });

    const res = mockRes();
    const next = jest.fn();

    await protect(mockReq('valid.token'), res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: 'Account is inactive' });
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects an unverified account with no profile', async () => {
    notBlacklisted();
    mockVerify.mockReturnValue({ id: 1 });
    mockPrisma.user.findUnique.mockResolvedValue({
      ...USER_ROW,
      is_verified: false,
      userProfile: null,
      vendorProfile: null,
    });

    const res = mockRes();
    const next = jest.fn();

    await protect(mockReq('valid.token'), res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: 'Account not verified' });
    expect(next).not.toHaveBeenCalled();
  });

  test('auto-verifies a legacy unverified account that already has a profile', async () => {
    notBlacklisted();
    mockVerify.mockReturnValue({ id: 1 });
    mockPrisma.user.findUnique.mockResolvedValue({ ...USER_ROW, is_verified: false });
    mockPrisma.user.update.mockResolvedValue({});

    const req = mockReq('valid.token');
    const next = jest.fn();

    await protect(req, mockRes(), next);

    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { is_verified: true },
    });
    expect(req.user.is_verified).toBe(true);
    expect(next).toHaveBeenCalled();
  });
});

// ─── blacklistToken ───────────────────────────────────────────────────────────

describe('blacklistToken', () => {
  test('upserts a row carrying the token and its expiry', async () => {
    mockPrisma.blacklistedToken.upsert.mockResolvedValue({});
    const exp = Math.floor(Date.now() / 1000) + 3600;

    await blacklistToken('some.jwt', exp);

    expect(mockPrisma.blacklistedToken.upsert).toHaveBeenCalledWith({
      where: { token: 'some.jwt' },
      update: { expiresAt: new Date(exp * 1000) },
      create: { token: 'some.jwt', expiresAt: new Date(exp * 1000) },
    });
  });

  // upsert rather than create, so logging out twice with the same token cannot
  // throw on the unique constraint.
  test('is safe to call twice with the same token', async () => {
    mockPrisma.blacklistedToken.upsert.mockResolvedValue({});
    const exp = Math.floor(Date.now() / 1000) + 3600;

    await blacklistToken('same.jwt', exp);
    await expect(blacklistToken('same.jwt', exp)).resolves.toBeUndefined();
    expect(mockPrisma.blacklistedToken.upsert).toHaveBeenCalledTimes(2);
  });

  test('writes nothing for a token that has already expired', async () => {
    const past = Math.floor(Date.now() / 1000) - 10;

    await blacklistToken('expired.jwt', past);

    // jwt.verify rejects it on signature expiry regardless, so a row would be
    // dead weight the cleanup cron then has to remove.
    expect(mockPrisma.blacklistedToken.upsert).not.toHaveBeenCalled();
  });

  test('swallows write errors rather than failing the logout request', async () => {
    mockPrisma.blacklistedToken.upsert.mockRejectedValue(new Error('db down'));
    const exp = Math.floor(Date.now() / 1000) + 3600;

    await expect(blacklistToken('some.jwt', exp)).resolves.toBeUndefined();
  });
});

// ─── isRefreshTokenBlacklisted ────────────────────────────────────────────────

describe('isRefreshTokenBlacklisted', () => {
  test('is true when a row exists', async () => {
    mockPrisma.blacklistedToken.findUnique.mockResolvedValue({ id: 3 });
    await expect(isRefreshTokenBlacklisted('r.jwt')).resolves.toBe(true);
  });

  test('is false when no row exists', async () => {
    mockPrisma.blacklistedToken.findUnique.mockResolvedValue(null);
    await expect(isRefreshTokenBlacklisted('r.jwt')).resolves.toBe(false);
  });

  test('fails closed on a lookup error', async () => {
    mockPrisma.blacklistedToken.findUnique.mockRejectedValue(new Error('db down'));
    await expect(isRefreshTokenBlacklisted('r.jwt')).resolves.toBe(true);
  });

  // Deliberately NOT given the access-token path's fail-open treatment. Refresh
  // tokens live for weeks; accepting one we cannot verify would mint a fresh
  // access token on every refresh for the whole duration of the fault.
  test('fails closed even when the query cannot run (P2021)', async () => {
    const err = new Error('table missing');
    err.code = 'P2021';
    mockPrisma.blacklistedToken.findUnique.mockRejectedValue(err);
    await expect(isRefreshTokenBlacklisted('r.jwt')).resolves.toBe(true);
  });
});

  // Deliberately NOT given the access-token path's fail-open treatment. Refresh
  // tokens live for weeks; accepting one we cannot verify would mint a fresh
  // access token on every refresh for the whole duration of the fault.
  test('fails closed even when the query cannot run (P2021)', async () => {
    const err = new Error('table missing');
    err.code = 'P2021';
    mockPrisma.blacklistedToken.findUnique.mockRejectedValue(err);
    await expect(isRefreshTokenBlacklisted('r.jwt')).resolves.toBe(true);
  });
});

// ─── invalidateUserCache ──────────────────────────────────────────────────────

describe('invalidateUserCache', () => {
  // Retained as a no-op so removing the cache did not ripple into call sites,
  // and so reintroducing one later has an obvious seam.
  test('resolves without touching the database', async () => {
    await expect(invalidateUserCache(42)).resolves.toBeUndefined();
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });
});
