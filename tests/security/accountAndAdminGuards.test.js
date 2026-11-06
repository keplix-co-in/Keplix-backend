// Security fixes 2026-11: email change (A-005), super_admin gate (A-021),
// upload limits + Multer mapping (A-010/A-008 area), parsePagination wiring.
import { jest } from '@jest/globals';

process.env.JWT_SECRET = 'test_access_secret';

const mockPrisma = {
  user: { findUnique: jest.fn(), update: jest.fn() },
  emailOTP: { findFirst: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn(), create: jest.fn() },
};
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../util/firebase.js', () => ({ default: { auth: () => ({}) }, messaging: null }));
jest.unstable_mockModule('google-auth-library', () => ({ OAuth2Client: jest.fn().mockImplementation(() => ({})) }));
const mockSendEmail = jest.fn().mockResolvedValue(true);
jest.unstable_mockModule('../../util/communication.js', () => ({
  sendEmail: mockSendEmail, sendSMS: jest.fn(), sendWhatsApp: jest.fn(), redactForLog: (x) => x,
}));

const { hashOTP } = await import('../../util/otp.js');
const { requestEmailChange, verifyEmailChange } = await import('../../controllers/authController.js');
const { authorizeSuperAdmin } = await import('../../middleware/authAdminMiddleware.js');
const { UPLOAD_LIMITS } = await import('../../middleware/uploadMiddleware.js');
const { errorHandler } = await import('../../middleware/errorMiddleware.js');

const mockRes = () => {
  const res = { statusCode: 200 };
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json = jest.fn().mockReturnValue(res);
  return res;
};
const me = { id: 5, email: 'old@example.com' };

beforeEach(() => jest.clearAllMocks());

describe('A-005 email change needs an OTP sent to the NEW address', () => {
  test('request rejects an address already in use', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 9 });
    const res = mockRes();
    await requestEmailChange({ user: me, body: { new_email: 'taken@example.com' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.emailOTP.create).not.toHaveBeenCalled();
  });
  test('request stores a hashed, purpose-scoped code and emails the new address', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = mockRes();
    await requestEmailChange({ user: me, body: { new_email: 'New@Example.com' } }, res);
    expect(res.json.mock.calls[0][0].success).toBe(true);
    const data = mockPrisma.emailOTP.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ email: 'new@example.com', purpose: 'email_change', userId: 5 });
    expect(data.otp).toMatch(/^[0-9a-f]{64}$/);
    expect(mockSendEmail.mock.calls[0][0]).toBe('new@example.com');
  });
  test('verify with a wrong code does not change the email', async () => {
    mockPrisma.emailOTP.findFirst.mockResolvedValue({ id: 1, otp: hashOTP('111111'), failedAttempts: 0 });
    mockPrisma.emailOTP.updateMany.mockResolvedValue({ count: 1 });
    const res = mockRes();
    await verifyEmailChange({ user: me, body: { new_email: 'new@example.com', otp: '222222' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].code).toBe('OTP_INVALID');
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
  test('verify with the right code swaps the email and tells the old address', async () => {
    mockPrisma.emailOTP.findFirst.mockResolvedValue({ id: 1, otp: hashOTP('111111'), failedAttempts: 0 });
    mockPrisma.emailOTP.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.update.mockResolvedValue({});
    const res = mockRes();
    await verifyEmailChange({ user: me, body: { new_email: 'new@example.com', otp: '111111' } }, res);
    expect(res.json).toHaveBeenCalledWith({ success: true, email: 'new@example.com' });
    expect(mockPrisma.user.update).toHaveBeenCalledWith({ where: { id: 5 }, data: { email: 'new@example.com' } });
    expect(mockSendEmail.mock.calls.some((c) => c[0] === 'old@example.com')).toBe(true);
  });
  test('verify maps a unique-constraint race to 409', async () => {
    mockPrisma.emailOTP.findFirst.mockResolvedValue({ id: 1, otp: hashOTP('111111'), failedAttempts: 0 });
    mockPrisma.emailOTP.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.update.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    const res = mockRes();
    await verifyEmailChange({ user: me, body: { new_email: 'new@example.com', otp: '111111' } }, res);
    expect(res.status).toHaveBeenCalledWith(409);
  });
});

describe('A-021 super_admin gate', () => {
  test('a plain admin is refused', () => {
    const res = mockRes(); const next = jest.fn();
    authorizeSuperAdmin({ user: { role: 'admin' } }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
  test('super_admin passes', () => {
    const next = jest.fn();
    authorizeSuperAdmin({ user: { role: 'super_admin' } }, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });
});

describe('Upload limits and Multer error mapping', () => {
  test('limits are bounded', () => {
    expect(UPLOAD_LIMITS.fileSize).toBeLessThanOrEqual(20 * 1024 * 1024);
    expect(UPLOAD_LIMITS.files).toBeGreaterThan(0);
  });
  test('LIMIT_FILE_SIZE -> 413, other Multer errors -> 400, no internals leaked', () => {
    const big = Object.assign(new Error('File too large'), { name: 'MulterError', code: 'LIMIT_FILE_SIZE' });
    const res1 = mockRes();
    errorHandler(big, { originalUrl: '/x', method: 'POST' }, res1, jest.fn());
    expect(res1.status).toHaveBeenCalledWith(413);

    const odd = Object.assign(new Error('Unexpected field'), { name: 'MulterError', code: 'LIMIT_UNEXPECTED_FILE' });
    const res2 = mockRes();
    errorHandler(odd, { originalUrl: '/x', method: 'POST' }, res2, jest.fn());
    expect(res2.status).toHaveBeenCalledWith(400);
    expect(JSON.stringify(res2.json.mock.calls[0][0])).not.toMatch(/at .*\.js:\d+/);
  });
});
