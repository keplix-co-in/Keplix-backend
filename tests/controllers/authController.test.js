import { jest } from '@jest/globals';

// Set env vars before the controller module loads (it reads them at import time)
process.env.JWT_SECRET = 'test_access_secret';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    userProfile: {
      create: jest.fn(),
    },
    vendorProfile: {
      create: jest.fn(),
    },
  },
}));

const mockVerifyIdToken = jest.fn();
const mockVerifyGoogleToken = jest.fn();
// util/redis.js opens a live IORedis connection at import time and is reached
// transitively through middleware/authMiddleware.js. Left unmocked it both
// requires a running Redis and keeps an open handle that stops jest exiting.
jest.unstable_mockModule('../../util/redis.js', () => ({
  default: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    setex: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(0),
    ping: jest.fn().mockResolvedValue('PONG'),
    quit: jest.fn().mockResolvedValue('OK'),
    on: jest.fn(),
  },
}));

jest.unstable_mockModule('../../util/firebase.js', () => ({
  default: {
    auth: () => ({ verifyIdToken: mockVerifyIdToken }),
  },
  messaging: null,
}));

// Google ID tokens are now verified with google-auth-library's OAuth2Client,
// which checks the AUDIENCE as well as the signature. The old firebase-admin /
// tokeninfo path was removed because it only checked the issuer, which let a
// token minted for any OAuth client log someone in.
jest.unstable_mockModule('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    verifyIdToken: mockVerifyGoogleToken,
  })),
}));

jest.unstable_mockModule('jsonwebtoken', () => ({
  default: {
    sign: jest.fn(() => 'signed_token'),
  },
}));

// ─── Lazy imports (after mocks are registered) ────────────────────────────────

const { googleLogin } = await import('../../controllers/authController.js');
const prisma = (await import('../../util/prisma.js')).default;

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

// email_verified is now required by googleLogin — Google saying it has not
// verified ownership of the address was half of the account-takeover chain.
const DECODED_TOKEN = { email: 'newuser@example.com', name: 'New User', email_verified: true };

const NEW_USER_ROW = (role) => ({
  id: 1,
  email: DECODED_TOKEN.email,
  role,
  is_active: true,
});

function withProfile(user, role) {
  if (role === 'vendor') {
    return { ...user, vendorProfile: { business_name: 'New User', phone: '' }, userProfile: null };
  }
  return { ...user, userProfile: { name: 'New User', phone: '' }, vendorProfile: null };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Without an audience allowlist googleLogin fails closed with a 500, so
  // these role tests need one configured.
  process.env.GOOGLE_ALLOWED_AUDIENCES = 'test-client.apps.googleusercontent.com';
  mockVerifyIdToken.mockResolvedValue(DECODED_TOKEN);
  mockVerifyGoogleToken.mockResolvedValue({ getPayload: () => DECODED_TOKEN });
});

describe('googleLogin - role whitelist enforcement', () => {

  it('defaults to "user" role when role is omitted for a new signup', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce(null) // initial lookup
      .mockResolvedValueOnce(withProfile(NEW_USER_ROW('user'), 'user')); // re-fetch after create
    prisma.user.create.mockResolvedValue(NEW_USER_ROW('user'));
    prisma.userProfile.create.mockResolvedValue({});

    const req = mockReq({ idToken: 'valid_token' });
    const res = mockRes();

    await googleLogin(req, res);

    expect(prisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ role: 'user' }),
    });
    expect(prisma.vendorProfile.create).not.toHaveBeenCalled();
    expect(prisma.userProfile.create).toHaveBeenCalled();
  });

  it('creates a vendor account and vendorProfile when role is "vendor"', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(withProfile(NEW_USER_ROW('vendor'), 'vendor'));
    prisma.user.create.mockResolvedValue(NEW_USER_ROW('vendor'));
    prisma.vendorProfile.create.mockResolvedValue({});

    const req = mockReq({ idToken: 'valid_token', role: 'vendor' });
    const res = mockRes();

    await googleLogin(req, res);

    expect(prisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ role: 'vendor' }),
    });
    expect(prisma.vendorProfile.create).toHaveBeenCalled();
    expect(prisma.userProfile.create).not.toHaveBeenCalled();
  });

  it('falls back to "user" when role is an unrecognized string (e.g. "admin"), even if middleware were bypassed', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(withProfile(NEW_USER_ROW('user'), 'user'));
    prisma.user.create.mockResolvedValue(NEW_USER_ROW('user'));
    prisma.userProfile.create.mockResolvedValue({});

    const req = mockReq({ idToken: 'valid_token', role: 'admin' });
    const res = mockRes();

    await googleLogin(req, res);

    expect(prisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ role: 'user' }),
    });
    expect(prisma.vendorProfile.create).not.toHaveBeenCalled();
    expect(prisma.userProfile.create).toHaveBeenCalled();
  });

  it('falls back to "user" for a case-variant role like "Vendor" (no case-insensitive bypass)', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(withProfile(NEW_USER_ROW('user'), 'user'));
    prisma.user.create.mockResolvedValue(NEW_USER_ROW('user'));
    prisma.userProfile.create.mockResolvedValue({});

    const req = mockReq({ idToken: 'valid_token', role: 'Vendor' });
    const res = mockRes();

    await googleLogin(req, res);

    expect(prisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ role: 'user' }),
    });
    expect(prisma.userProfile.create).toHaveBeenCalled();
  });

  it('falls back to "user" for an empty string role', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(withProfile(NEW_USER_ROW('user'), 'user'));
    prisma.user.create.mockResolvedValue(NEW_USER_ROW('user'));
    prisma.userProfile.create.mockResolvedValue({});

    const req = mockReq({ idToken: 'valid_token', role: '' });
    const res = mockRes();

    await googleLogin(req, res);

    expect(prisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ role: 'user' }),
    });
  });

  it('falls back to "user" when role is a non-string type (array/object/number)', async () => {
    for (const badRole of [['vendor'], { role: 'vendor' }, 123]) {
      jest.clearAllMocks();
      mockVerifyIdToken.mockResolvedValue(DECODED_TOKEN);
      // Re-seed the Google verifier too — clearAllMocks wipes it, and without
      // it every iteration after the first fails verification.
      mockVerifyGoogleToken.mockResolvedValue({ getPayload: () => DECODED_TOKEN });
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(withProfile(NEW_USER_ROW('user'), 'user'));
      prisma.user.create.mockResolvedValue(NEW_USER_ROW('user'));
      prisma.userProfile.create.mockResolvedValue({});

      const req = mockReq({ idToken: 'valid_token', role: badRole });
      const res = mockRes();

      await googleLogin(req, res);

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ role: 'user' }),
      });
    }
  });

  it('does not use the client-supplied role at all for an existing user (role is immutable via this endpoint)', async () => {
    const existingAdmin = {
      id: 5,
      email: DECODED_TOKEN.email,
      role: 'user',
      is_active: true,
      userProfile: { name: 'Existing', phone: '' },
      vendorProfile: null,
    };
    prisma.user.findUnique.mockResolvedValueOnce(existingAdmin);

    const req = mockReq({ idToken: 'valid_token', role: 'admin' });
    const res = mockRes();

    await googleLogin(req, res);

    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ role: 'user' }) })
    );
  });

  it('returns 401 when the ID token is invalid', async () => {
    // Rejected by the audience/signature check in google-auth-library.
    // There is deliberately no /tokeninfo fallback any more — that fallback
    // was the vulnerability.
    mockVerifyGoogleToken.mockRejectedValue(new Error('Wrong recipient'));

    const req = mockReq({ idToken: 'garbage', role: 'vendor' });
    const res = mockRes();

    await googleLogin(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});
