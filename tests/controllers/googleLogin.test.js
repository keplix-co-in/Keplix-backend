import { jest } from '@jest/globals';

/**
 * Regression tests for the Google sign-in audience-confusion vulnerability.
 *
 * The original handler verified a Google ID token by GETting
 * /tokeninfo and checking only `iss` — "did Google issue this?" — never `aud`,
 * "was it issued to US?". Since the apps send raw Google ID tokens (not
 * Firebase ones) that fallback ran on every request, so a token minted for ANY
 * Google OAuth client was accepted, and the handler then linked to an existing
 * account by email alone. That was full account takeover from an email address.
 *
 * These tests pin the two properties that close it: the audience allowlist is
 * actually passed to the verifier, and an unverified email is refused.
 */

const mockPrisma = {
  user: { findUnique: jest.fn(), create: jest.fn() },
  userProfile: { create: jest.fn() },
  vendorProfile: { create: jest.fn() },
};

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));

const mockVerifyIdToken = jest.fn();
jest.unstable_mockModule('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    verifyIdToken: mockVerifyIdToken,
  })),
}));

// firebase-admin is imported at module load by the controller.
jest.unstable_mockModule('../../util/firebase.js', () => ({
  default: { auth: () => ({ verifyIdToken: jest.fn() }) },
}));

jest.unstable_mockModule('../../middleware/authMiddleware.js', () => ({
  blacklistToken: jest.fn(),
  isRefreshTokenBlacklisted: jest.fn().mockResolvedValue(false),
}));

jest.unstable_mockModule('../../util/resend.js', () => ({ resend: {} }));
jest.unstable_mockModule('../../util/communication.js', () => ({
  sendEmail: jest.fn(),
  sendSMS: jest.fn(),
}));

const { googleLogin } = await import('../../controllers/authController.js');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const VALID_TOKEN = 'aaa.bbb.ccc';

function payload(overrides = {}) {
  return {
    email: 'victim@example.com',
    email_verified: true,
    name: 'Victim',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GOOGLE_ALLOWED_AUDIENCES = 'client-a.apps.googleusercontent.com,client-b.apps.googleusercontent.com';
  process.env.JWT_SECRET = 'test-secret';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
  mockVerifyIdToken.mockResolvedValue({ getPayload: () => payload() });
  mockPrisma.user.findUnique.mockResolvedValue({
    id: 1, email: 'victim@example.com', role: 'user', userProfile: { name: 'Victim' }, vendorProfile: null,
  });
});

describe('googleLogin — token verification', () => {
  // The core of the fix.
  test('passes the audience allowlist to verifyIdToken', async () => {
    const res = mockRes();
    await googleLogin({ body: { idToken: VALID_TOKEN } }, res);

    expect(mockVerifyIdToken).toHaveBeenCalledWith(
      expect.objectContaining({
        idToken: VALID_TOKEN,
        audience: [
          'client-a.apps.googleusercontent.com',
          'client-b.apps.googleusercontent.com',
        ],
      }),
    );
  });

  // A token for someone else's OAuth client: verifyIdToken rejects on audience.
  test('rejects a token whose audience is not ours', async () => {
    mockVerifyIdToken.mockRejectedValue(
      new Error('Wrong recipient, payload audience != requiredAudience'),
    );
    const res = mockRes();

    await googleLogin({ body: { idToken: VALID_TOKEN } }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  // Without an allowlist verifyIdToken would accept ANY audience, silently
  // reopening the hole — so a missing env var must fail closed.
  test('refuses to verify at all when the audience allowlist is unset', async () => {
    delete process.env.GOOGLE_ALLOWED_AUDIENCES;
    const res = mockRes();

    await googleLogin({ body: { idToken: VALID_TOKEN } }, res);

    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  test('rejects an unverified Google email', async () => {
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => payload({ email_verified: false }),
    });
    const res = mockRes();

    await googleLogin({ body: { idToken: VALID_TOKEN } }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    // Must not link to the existing account, which is the takeover path.
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  test('rejects a token carrying no email', async () => {
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ email_verified: true }),
    });
    const res = mockRes();

    await googleLogin({ body: { idToken: VALID_TOKEN } }, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('accepts a properly audienced, verified token', async () => {
    const res = mockRes();

    await googleLogin({ body: { idToken: VALID_TOKEN } }, res);

    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'victim@example.com' } }),
    );
  });
});
