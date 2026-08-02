import { jest } from '@jest/globals';

// Set env vars before the controller module loads (it reads them at import time)
process.env.JWT_SECRET = 'test_access_secret';
process.env.JWT_REFRESH_SECRET = 'test_refresh_secret';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.unstable_mockModule('../../../util/prisma.js', () => ({
  default: {
    admin: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.unstable_mockModule('bcryptjs', () => ({
  default: {
    compare: jest.fn(),
    hash: jest.fn(),
  },
}));

jest.unstable_mockModule('jsonwebtoken', () => ({
  default: {
    sign: jest.fn(),
    verify: jest.fn(),
  },
}));

// ─── Lazy imports (after mocks are registered) ────────────────────────────────

const { login, refresh, logout } = await import('../../../controllers/Admin/authController.js');
const prisma = (await import('../../../util/prisma.js')).default;
const bcrypt = (await import('bcryptjs')).default;
const jwt = (await import('jsonwebtoken')).default;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockReq(body = {}) {
  return { body };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const ACTIVE_ADMIN = {
  id: 1,
  email: 'admin@keplix.com',
  name: 'Admin',
  role: 'admin',
  status: 'ACTIVE',
  password: '$hashed_password',
  refreshToken: '$hashed_refresh_token',
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── login ────────────────────────────────────────────────────────────────────

describe('login', () => {

  it('returns 404 when admin email does not exist', async () => {
    prisma.admin.findUnique.mockResolvedValue(null);
    const req = mockReq({ email: 'unknown@keplix.com', password: 'pass' });
    const res = mockRes();

    await login(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Admin not found' });
  });

  it('returns 403 when admin account is not ACTIVE', async () => {
    prisma.admin.findUnique.mockResolvedValue({ ...ACTIVE_ADMIN, status: 'SUSPENDED' });
    const req = mockReq({ email: 'admin@keplix.com', password: 'pass' });
    const res = mockRes();

    await login(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: 'Account is not active' });
  });

  it('returns 401 when password is wrong', async () => {
    prisma.admin.findUnique.mockResolvedValue(ACTIVE_ADMIN);
    bcrypt.compare.mockResolvedValue(false);
    const req = mockReq({ email: 'admin@keplix.com', password: 'wrong' });
    const res = mockRes();

    await login(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid password' });
  });

  it('returns accessToken and refreshToken on valid credentials', async () => {
    prisma.admin.findUnique.mockResolvedValue(ACTIVE_ADMIN);
    bcrypt.compare.mockResolvedValue(true);
    bcrypt.hash.mockResolvedValue('$new_hashed_refresh');
    jwt.sign
      .mockReturnValueOnce('access_token_value')
      .mockReturnValueOnce('refresh_token_value');
    prisma.admin.update.mockResolvedValue({});

    const req = mockReq({ email: 'admin@keplix.com', password: 'correct' });
    const res = mockRes();

    await login(req, res);

    expect(res.json).toHaveBeenCalledWith({
      user: { id: 1, email: 'admin@keplix.com', name: 'Admin', role: 'admin' },
      accessToken: 'access_token_value',
      refreshToken: 'refresh_token_value',
    });
  });

  it('access token expiry is 15m (not 30d)', async () => {
    prisma.admin.findUnique.mockResolvedValue(ACTIVE_ADMIN);
    bcrypt.compare.mockResolvedValue(true);
    bcrypt.hash.mockResolvedValue('$hash');
    jwt.sign.mockReturnValue('token');
    prisma.admin.update.mockResolvedValue({});

    const req = mockReq({ email: 'admin@keplix.com', password: 'correct' });
    await login(req, mockRes());

    // First sign call is the access token
    const [, , accessOptions] = jwt.sign.mock.calls[0];
    expect(accessOptions.expiresIn).toBe('15m');
  });

  it('refresh token expiry is 7d (not 30d)', async () => {
    prisma.admin.findUnique.mockResolvedValue(ACTIVE_ADMIN);
    bcrypt.compare.mockResolvedValue(true);
    bcrypt.hash.mockResolvedValue('$hash');
    jwt.sign.mockReturnValue('token');
    prisma.admin.update.mockResolvedValue({});

    const req = mockReq({ email: 'admin@keplix.com', password: 'correct' });
    await login(req, mockRes());

    // Second sign call is the refresh token
    const [, , refreshOptions] = jwt.sign.mock.calls[1];
    expect(refreshOptions.expiresIn).toBe('7d');
  });

  it('access token and refresh token use different secrets', async () => {
    prisma.admin.findUnique.mockResolvedValue(ACTIVE_ADMIN);
    bcrypt.compare.mockResolvedValue(true);
    bcrypt.hash.mockResolvedValue('$hash');
    jwt.sign.mockReturnValue('token');
    prisma.admin.update.mockResolvedValue({});

    const req = mockReq({ email: 'admin@keplix.com', password: 'correct' });
    await login(req, mockRes());

    const [, accessSecret] = jwt.sign.mock.calls[0];
    const [, refreshSecret] = jwt.sign.mock.calls[1];
    expect(accessSecret).not.toBe(refreshSecret);
  });

  it('stores bcrypt hash of refresh token in DB (not the raw token)', async () => {
    prisma.admin.findUnique.mockResolvedValue(ACTIVE_ADMIN);
    bcrypt.compare.mockResolvedValue(true);
    bcrypt.hash.mockResolvedValue('$bcrypt_hash');
    jwt.sign
      .mockReturnValueOnce('access_tok')
      .mockReturnValueOnce('refresh_tok');
    prisma.admin.update.mockResolvedValue({});

    const req = mockReq({ email: 'admin@keplix.com', password: 'correct' });
    await login(req, mockRes());

    const updateCall = prisma.admin.update.mock.calls[0][0];
    // Must store the hash, never the raw token string
    expect(updateCall.data.refreshToken).toBe('$bcrypt_hash');
    expect(updateCall.data.refreshToken).not.toBe('refresh_tok');
  });

  it('returns 500 on unexpected DB error', async () => {
    prisma.admin.findUnique.mockRejectedValue(new Error('DB down'));
    const req = mockReq({ email: 'admin@keplix.com', password: 'pass' });
    const res = mockRes();

    await login(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'Server error' });
  });
});

// ─── refresh ──────────────────────────────────────────────────────────────────

describe('refresh', () => {

  it('returns 401 when refreshToken is missing from body', async () => {
    const req = mockReq({});
    const res = mockRes();

    await refresh(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Refresh token required' });
  });

  it('returns 401 when JWT signature is invalid', async () => {
    jwt.verify.mockImplementation(() => { throw Object.assign(new Error(), { name: 'JsonWebTokenError' }); });
    const req = mockReq({ refreshToken: 'bad_token' });
    const res = mockRes();

    await refresh(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid refresh token' });
  });

  it('returns 401 when refresh token is expired', async () => {
    jwt.verify.mockImplementation(() => { throw Object.assign(new Error(), { name: 'TokenExpiredError' }); });
    const req = mockReq({ refreshToken: 'expired_token' });
    const res = mockRes();

    await refresh(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Refresh token expired. Please log in again.' });
  });

  it('returns 401 when admin no longer exists in DB', async () => {
    jwt.verify.mockReturnValue({ id: 99, role: 'admin' });
    prisma.admin.findUnique.mockResolvedValue(null);
    const req = mockReq({ refreshToken: 'valid_jwt_unknown_admin' });
    const res = mockRes();

    await refresh(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid refresh token' });
  });

  it('returns 401 when admin has no stored refresh token (already logged out)', async () => {
    jwt.verify.mockReturnValue({ id: 1, role: 'admin' });
    prisma.admin.findUnique.mockResolvedValue({ ...ACTIVE_ADMIN, refreshToken: null });
    const req = mockReq({ refreshToken: 'some_token' });
    const res = mockRes();

    await refresh(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid refresh token' });
  });

  it('detects token reuse: clears stored token and returns 401', async () => {
    jwt.verify.mockReturnValue({ id: 1, role: 'admin' });
    prisma.admin.findUnique.mockResolvedValue(ACTIVE_ADMIN);
    // bcrypt compare fails — token hash does not match (reuse scenario)
    bcrypt.compare.mockResolvedValue(false);
    prisma.admin.update.mockResolvedValue({});

    const req = mockReq({ refreshToken: 'reused_token' });
    const res = mockRes();

    await refresh(req, res);

    // Stored token must be cleared to force re-login
    expect(prisma.admin.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { refreshToken: null },
    });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Refresh token reuse detected. Please log in again.',
    });
  });

  it('rotates tokens: issues new pair and persists new hash on valid token', async () => {
    jwt.verify.mockReturnValue({ id: 1, role: 'admin' });
    prisma.admin.findUnique.mockResolvedValue(ACTIVE_ADMIN);
    bcrypt.compare.mockResolvedValue(true);
    bcrypt.hash.mockResolvedValue('$new_hash');
    jwt.sign
      .mockReturnValueOnce('new_access_token')
      .mockReturnValueOnce('new_refresh_token');
    prisma.admin.update.mockResolvedValue({});

    const req = mockReq({ refreshToken: 'valid_refresh_token' });
    const res = mockRes();

    await refresh(req, res);

    expect(prisma.admin.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { refreshToken: '$new_hash' },
    });
    expect(res.json).toHaveBeenCalledWith({
      accessToken: 'new_access_token',
      refreshToken: 'new_refresh_token',
    });
  });

  it('old refresh token cannot be reused after rotation', async () => {
    // First use — valid
    jwt.verify.mockReturnValue({ id: 1, role: 'admin' });
    prisma.admin.findUnique.mockResolvedValue(ACTIVE_ADMIN);
    bcrypt.compare.mockResolvedValueOnce(true); // first use succeeds
    bcrypt.hash.mockResolvedValue('$rotated_hash');
    jwt.sign.mockReturnValue('token');
    prisma.admin.update.mockResolvedValue({});

    await refresh(mockReq({ refreshToken: 'old_token' }), mockRes());

    // Second use — DB now holds the rotated hash, compare returns false
    prisma.admin.findUnique.mockResolvedValue({ ...ACTIVE_ADMIN, refreshToken: '$rotated_hash' });
    bcrypt.compare.mockResolvedValueOnce(false); // old token no longer matches
    prisma.admin.update.mockResolvedValue({});

    const res2 = mockRes();
    await refresh(mockReq({ refreshToken: 'old_token' }), res2);

    expect(res2.status).toHaveBeenCalledWith(401);
    expect(res2.json).toHaveBeenCalledWith({
      message: 'Refresh token reuse detected. Please log in again.',
    });
  });

  it('new access token uses 15m expiry after rotation', async () => {
    jwt.verify.mockReturnValue({ id: 1, role: 'admin' });
    prisma.admin.findUnique.mockResolvedValue(ACTIVE_ADMIN);
    bcrypt.compare.mockResolvedValue(true);
    bcrypt.hash.mockResolvedValue('$hash');
    jwt.sign.mockReturnValue('token');
    prisma.admin.update.mockResolvedValue({});

    await refresh(mockReq({ refreshToken: 'valid_token' }), mockRes());

    const [, , accessOptions] = jwt.sign.mock.calls[0];
    expect(accessOptions.expiresIn).toBe('15m');
  });

  it('returns 500 on unexpected DB error during rotation', async () => {
    jwt.verify.mockReturnValue({ id: 1, role: 'admin' });
    prisma.admin.findUnique.mockRejectedValue(new Error('DB down'));

    const res = mockRes();
    await refresh(mockReq({ refreshToken: 'valid_token' }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'Server error' });
  });
});

// ─── logout ───────────────────────────────────────────────────────────────────

describe('logout', () => {

  it('returns 400 when refreshToken is missing', async () => {
    const res = mockRes();
    await logout(mockReq({}), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'Refresh token required' });
  });

  it('returns 401 when refresh token JWT is invalid', async () => {
    jwt.verify.mockImplementation(() => { throw Object.assign(new Error(), { name: 'JsonWebTokenError' }); });

    const res = mockRes();
    await logout(mockReq({ refreshToken: 'bad_token' }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid refresh token' });
  });

  it('returns 401 when refresh token is expired', async () => {
    jwt.verify.mockImplementation(() => { throw Object.assign(new Error(), { name: 'TokenExpiredError' }); });

    const res = mockRes();
    await logout(mockReq({ refreshToken: 'expired_token' }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid refresh token' });
  });

  it('clears the stored refresh token hash from DB on valid logout', async () => {
    jwt.verify.mockReturnValue({ id: 1, role: 'admin' });
    prisma.admin.update.mockResolvedValue({});

    const res = mockRes();
    await logout(mockReq({ refreshToken: 'valid_refresh' }), res);

    expect(prisma.admin.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { refreshToken: null },
    });
    expect(res.json).toHaveBeenCalledWith({ message: 'Logged out successfully' });
  });

  it('after logout the refresh token cannot be rotated (stored hash is null)', async () => {
    // Simulate post-logout state: DB has null refreshToken
    jwt.verify.mockReturnValue({ id: 1, role: 'admin' });
    prisma.admin.findUnique.mockResolvedValue({ ...ACTIVE_ADMIN, refreshToken: null });

    const res = mockRes();
    await refresh(mockReq({ refreshToken: 'post_logout_token' }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid refresh token' });
  });

  it('returns 500 on unexpected DB error during logout', async () => {
    jwt.verify.mockReturnValue({ id: 1, role: 'admin' });
    prisma.admin.update.mockRejectedValue(new Error('DB down'));

    const res = mockRes();
    await logout(mockReq({ refreshToken: 'valid_refresh' }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'Server error' });
  });
});
