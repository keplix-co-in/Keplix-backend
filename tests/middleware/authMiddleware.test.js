import { jest } from '@jest/globals';

process.env.JWT_SECRET = 'test_access_secret';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: mockPrisma,
}));

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
};

jest.unstable_mockModule('../../util/redis.js', () => ({
  default: mockRedis,
}));

const mockVerify = jest.fn();
jest.unstable_mockModule('jsonwebtoken', () => ({
  default: {
    verify: (...args) => mockVerify(...args),
  },
}));

// ─── Lazy imports (after mocks are registered) ────────────────────────────────

const { protect, invalidateUserCache } = await import(
  '../../middleware/authMiddleware.js'
);

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

beforeEach(() => {
  jest.clearAllMocks();
});

// mockRedis.get backs both the blacklist check and the user cache lookup,
// keyed by prefix, since both now live in the same Redis instance.
function setupRedisGet({
  blacklisted = false,
  blacklistError = false,
  cachedUser = null,
  cacheError = false,
} = {}) {
  mockRedis.get.mockImplementation((key) => {
    if (key.startsWith('auth:blacklist:')) {
      if (blacklistError) return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve(blacklisted ? '1' : null);
    }
    if (cacheError) return Promise.reject(new Error('ECONNREFUSED'));
    return Promise.resolve(cachedUser);
  });
}

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
    setupRedisGet();
    mockVerify.mockImplementation(() => {
      throw new Error('jwt expired');
    });

    const req = mockReq('bad.token.here');
    const res = mockRes();
    const next = jest.fn();

    await protect(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Not authorized, token failed' });
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── Blacklisted token ────────────────────────────────────────────────────────

describe('protect - blacklisted token', () => {
  test('rejects a blacklisted token before touching the user cache or user table', async () => {
    setupRedisGet({ blacklisted: true });

    const req = mockReq('blacklisted');
    const res = mockRes();
    const next = jest.fn();

    await protect(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Token has been logged out' });
    expect(mockRedis.get).toHaveBeenCalledTimes(1);
    expect(mockRedis.get).toHaveBeenCalledWith('auth:blacklist:blacklisted');
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── Cache hit path ───────────────────────────────────────────────────────────

describe('protect - Redis cache hit', () => {
  test('uses the cached user and skips the DB user lookup entirely', async () => {
    setupRedisGet({ cachedUser: JSON.stringify(USER_ROW) });
    mockVerify.mockReturnValue({ id: 1 });

    const req = mockReq('valid.token');
    const res = mockRes();
    const next = jest.fn();

    await protect(req, res, next);

    expect(mockRedis.get).toHaveBeenCalledWith('auth:user:1');
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(req.user).toEqual(USER_ROW);
    expect(next).toHaveBeenCalled();
  });

  test('falls back to DB when cached value is corrupt/unparseable JSON', async () => {
    setupRedisGet({ cachedUser: '{not valid json' });
    mockVerify.mockReturnValue({ id: 1 });
    mockPrisma.user.findUnique.mockResolvedValue(USER_ROW);

    const req = mockReq('valid.token');
    const res = mockRes();
    const next = jest.fn();

    await protect(req, res, next);

    expect(mockPrisma.user.findUnique).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});

// ─── Cache miss path ──────────────────────────────────────────────────────────

describe('protect - Redis cache miss', () => {
  test('fetches from DB and populates the cache on a miss', async () => {
    setupRedisGet({ cachedUser: null });
    mockVerify.mockReturnValue({ id: 1 });
    mockPrisma.user.findUnique.mockResolvedValue(USER_ROW);

    const req = mockReq('valid.token');
    const res = mockRes();
    const next = jest.fn();

    await protect(req, res, next);

    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      include: { userProfile: true, vendorProfile: true },
    });
    expect(mockRedis.set).toHaveBeenCalledWith(
      'auth:user:1',
      JSON.stringify(USER_ROW),
      'EX',
      expect.any(Number)
    );
    expect(next).toHaveBeenCalled();
  });

  test('does not write to cache when the user is not found in DB', async () => {
    setupRedisGet({ cachedUser: null });
    mockVerify.mockReturnValue({ id: 999 });
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const req = mockReq('valid.token');
    const res = mockRes();
    const next = jest.fn();

    await protect(req, res, next);

    expect(mockRedis.set).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Not authorized, user not found' });
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── Redis unavailable / errors (must not break auth) ────────────────────────

describe('protect - Redis failures degrade gracefully', () => {
  test('falls back to DB when the user-cache redis.get rejects (Redis down)', async () => {
    setupRedisGet({ cacheError: true });
    mockVerify.mockReturnValue({ id: 1 });
    mockPrisma.user.findUnique.mockResolvedValue(USER_ROW);

    const req = mockReq('valid.token');
    const res = mockRes();
    const next = jest.fn();

    await protect(req, res, next);

    expect(mockPrisma.user.findUnique).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  test('still authenticates when redis.set rejects after a DB fetch', async () => {
    setupRedisGet({ cachedUser: null });
    mockVerify.mockReturnValue({ id: 1 });
    mockRedis.set.mockRejectedValue(new Error('ECONNREFUSED'));
    mockPrisma.user.findUnique.mockResolvedValue(USER_ROW);

    const req = mockReq('valid.token');
    const res = mockRes();
    const next = jest.fn();

    await protect(req, res, next);

    expect(req.user).toEqual(USER_ROW);
    expect(next).toHaveBeenCalled();
  });

  test('fails closed (rejects the request) when the blacklist redis.get errors', async () => {
    setupRedisGet({ blacklistError: true });
    mockVerify.mockReturnValue({ id: 1 });

    const req = mockReq('valid.token');
    const res = mockRes();
    const next = jest.fn();

    await protect(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Token has been logged out' });
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── Account state checks (inactive / unverified) ────────────────────────────

describe('protect - account state checks', () => {
  test('rejects an inactive account', async () => {
    setupRedisGet({ cachedUser: JSON.stringify({ ...USER_ROW, is_active: false }) });
    mockVerify.mockReturnValue({ id: 1 });

    const req = mockReq('valid.token');
    const res = mockRes();
    const next = jest.fn();

    await protect(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: 'Account is inactive' });
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects an unverified account with no profile', async () => {
    setupRedisGet({
      cachedUser: JSON.stringify({ ...USER_ROW, is_verified: false, userProfile: null, vendorProfile: null }),
    });
    mockVerify.mockReturnValue({ id: 1 });

    const req = mockReq('valid.token');
    const res = mockRes();
    const next = jest.fn();

    await protect(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: 'Account not verified' });
    expect(next).not.toHaveBeenCalled();
  });

  test('auto-verifies a legacy unverified account that already has a profile, and invalidates its cache', async () => {
    setupRedisGet({
      cachedUser: JSON.stringify({ ...USER_ROW, is_verified: false, userProfile: { id: 10 } }),
    });
    mockVerify.mockReturnValue({ id: 1 });
    mockPrisma.user.update.mockResolvedValue({});

    const req = mockReq('valid.token');
    const res = mockRes();
    const next = jest.fn();

    await protect(req, res, next);

    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { is_verified: true },
    });
    expect(mockRedis.del).toHaveBeenCalledWith('auth:user:1');
    expect(req.user.is_verified).toBe(true);
    expect(next).toHaveBeenCalled();
  });
});

// ─── Cache key isolation across users ─────────────────────────────────────────

describe('protect - cache key isolation', () => {
  test('different user ids use different, non-colliding cache keys', async () => {
    setupRedisGet({ cachedUser: null });
    mockPrisma.user.findUnique.mockResolvedValue(USER_ROW);

    mockVerify.mockReturnValue({ id: 1 });
    await protect(mockReq('token1'), mockRes(), jest.fn());

    mockVerify.mockReturnValue({ id: 2 });
    await protect(mockReq('token2'), mockRes(), jest.fn());

    const userCacheCalls = mockRedis.get.mock.calls
      .map(([key]) => key)
      .filter((key) => key.startsWith('auth:user:'));

    expect(userCacheCalls).toEqual(['auth:user:1', 'auth:user:2']);
  });
});

// ─── invalidateUserCache helper ───────────────────────────────────────────────

describe('invalidateUserCache', () => {
  test('deletes the correct Redis key for a given user id', async () => {
    mockRedis.del.mockResolvedValue(1);

    await invalidateUserCache(42);

    expect(mockRedis.del).toHaveBeenCalledWith('auth:user:42');
  });

  test('swallows Redis errors instead of throwing', async () => {
    mockRedis.del.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(invalidateUserCache(42)).resolves.toBeUndefined();
  });
});
