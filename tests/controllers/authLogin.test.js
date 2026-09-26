import { jest } from '@jest/globals';

// Set env vars before the controller module loads (it reads them at import time)
process.env.JWT_SECRET = 'test_access_secret';
process.env.JWT_REFRESH_SECRET = 'test_refresh_secret';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));

jest.unstable_mockModule('bcryptjs', () => ({
  default: { compare: jest.fn().mockResolvedValue(true) },
}));

jest.unstable_mockModule('jsonwebtoken', () => ({
  default: { sign: jest.fn().mockReturnValue('signed.jwt'), verify: jest.fn() },
}));

const { authUser } = await import('../../controllers/authController.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mockReq = (body = {}) => ({ body });

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const vendorRow = (overrides = {}) => ({
  id: 7,
  email: 'partner@example.com',
  password: '$2a$10$hashedhashedhashedhashed',
  role: 'vendor',
  is_active: true,
  is_verified: true,
  userProfile: null,
  vendorProfile: {
    business_name: 'Ravi Motors',
    phone: '9876543210',
    address: 'MG Road',
    image: 'https://cdn/img.jpg',
    cover_image: 'https://cdn/cover.jpg',
    onboarding_completed: true,
    status: 'approved',
    ...overrides,
  },
});

/** The single object the vendor app reads after login. */
const loginUser = (res) => res.json.mock.calls[0][0].user;

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── The regression ───────────────────────────────────────────────────────────

describe('authUser - vendor login payload', () => {
  // The bug: this branch built profileData without onboarding_completed, so the
  // field arrived `undefined`. resolveVendorLanding (vendor app,
  // utils/vendorLanding.js:63) routes on `!user.onboarding_completed`, so every
  // returning vendor was sent to OnboardingStart instead of HomePage. googleLogin
  // always included it, which is why only email login was affected.
  test('includes onboarding_completed:true for a fully onboarded vendor', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(vendorRow());
    const res = mockRes();

    await authUser(mockReq({ email: 'partner@example.com', password: 'pw' }), res);

    expect(loginUser(res).onboarding_completed).toBe(true);
  });

  test('includes onboarding_completed:false for a vendor mid-onboarding', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      vendorRow({ onboarding_completed: false, status: 'pending' })
    );
    const res = mockRes();

    await authUser(mockReq({ email: 'partner@example.com', password: 'pw' }), res);

    // Must stay falsy — an unfinished vendor still belongs in onboarding.
    expect(loginUser(res).onboarding_completed).toBe(false);
  });

  // undefined and false route identically today, so assert the field is actually
  // present rather than merely falsy — that distinction is the whole bug.
  test('onboarding_completed is never undefined', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(vendorRow({ onboarding_completed: false }));
    const res = mockRes();

    await authUser(mockReq({ email: 'partner@example.com', password: 'pw' }), res);

    expect(loginUser(res)).toHaveProperty('onboarding_completed');
    expect(loginUser(res).onboarding_completed).not.toBeUndefined();
  });

  test('carries status, for parity with googleLogin', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(vendorRow());
    const res = mockRes();

    await authUser(mockReq({ email: 'partner@example.com', password: 'pw' }), res);

    expect(loginUser(res).status).toBe('approved');
  });

  // resolveVendorLanding rejects any non-vendor role before it looks at
  // onboarding, so role must survive the response too.
  test('carries role and the existing profile fields', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(vendorRow());
    const res = mockRes();

    await authUser(mockReq({ email: 'partner@example.com', password: 'pw' }), res);

    const user = loginUser(res);
    expect(user.role).toBe('vendor');
    expect(user.business_name).toBe('Ravi Motors');
    expect(user.cover_image).toBe('https://cdn/cover.jpg');
    expect(user.phone_number).toBe('9876543210');
  });
});

describe('authUser - customer login payload', () => {
  test('is unaffected by the vendor fields', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 3,
      email: 'customer@example.com',
      password: '$2a$10$hashedhashedhashedhashed',
      role: 'user',
      is_active: true,
      is_verified: true,
      vendorProfile: null,
      userProfile: { name: 'Asha', phone: '9000000000', address: 'Indiranagar', profile_picture: null },
    });
    const res = mockRes();

    await authUser(mockReq({ email: 'customer@example.com', password: 'pw' }), res);

    const user = loginUser(res);
    expect(user.role).toBe('user');
    expect(user.name).toBe('Asha');
    expect(user.onboarding_completed).toBeUndefined();
  });
});

describe('authUser - legacy Django pbkdf2_sha256 password (audit #124)', () => {
  /**
   * verifyDjangoPassword used crypto.pbkdf2Sync (blocking) before; now uses
   * the async crypto.pbkdf2 promisified. This exercises the real crypto
   * path (not mocked) end to end with a genuine Django-format hash to prove
   * the promisified version still authenticates correctly, not just that it
   * doesn't throw.
   */
  test('authenticates a real pbkdf2_sha256 hash with the correct password', async () => {
    const crypto = await import('crypto');
    const password = 'correct horse battery staple';
    const salt = 'testsalt123';
    const iterations = 20000;
    const derivedKey = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
    const djangoHash = `pbkdf2_sha256$${iterations}$${salt}$${derivedKey.toString('base64')}`;

    mockPrisma.user.findUnique.mockResolvedValue({
      id: 9,
      email: 'legacy@example.com',
      password: djangoHash,
      role: 'user',
      is_active: true,
      is_verified: true,
      vendorProfile: null,
      userProfile: { name: 'Legacy User', phone: '9111111111', address: 'MG Road', profile_picture: null },
    });
    const res = mockRes();

    await authUser(mockReq({ email: 'legacy@example.com', password }), res);

    expect(res.status).not.toHaveBeenCalledWith(401);
    const user = loginUser(res);
    expect(user.name).toBe('Legacy User');
  });

  test('rejects a real pbkdf2_sha256 hash with the wrong password', async () => {
    const crypto = await import('crypto');
    const salt = 'testsalt123';
    const iterations = 20000;
    const derivedKey = crypto.pbkdf2Sync('the real password', salt, iterations, 32, 'sha256');
    const djangoHash = `pbkdf2_sha256$${iterations}$${salt}$${derivedKey.toString('base64')}`;

    mockPrisma.user.findUnique.mockResolvedValue({
      id: 9,
      email: 'legacy@example.com',
      password: djangoHash,
      role: 'user',
      is_active: true,
      is_verified: true,
      vendorProfile: null,
      userProfile: { name: 'Legacy User' },
    });
    const res = mockRes();

    await authUser(mockReq({ email: 'legacy@example.com', password: 'wrong password' }), res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});
