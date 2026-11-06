// Security fixes 2026-11: vendor-side guards (A-020, A-023, A-017/18/19, A-024, A-022).
import { jest } from '@jest/globals';
import crypto from 'crypto';

const mockPrisma = {
  vendorProfile: { findUnique: jest.fn() },
  vendorPayoutAccount: { findUnique: jest.fn() },
  emailOTP: { findFirst: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn(), create: jest.fn() },
  user: { findUnique: jest.fn() },
  payment: { create: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  walkInJob: { findFirst: jest.fn(), updateMany: jest.fn() },
};
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
const mockSendEmail = jest.fn().mockResolvedValue(true);
jest.unstable_mockModule('../../util/communication.js', () => ({
  sendEmail: mockSendEmail, sendSMS: jest.fn(), sendWhatsApp: jest.fn(), redactForLog: (x) => x,
}));
jest.unstable_mockModule('../../util/notificationHelper.js', () => ({ createNotification: jest.fn() }));
jest.unstable_mockModule('../../queues/notificationQueue.js', () => ({ addNotificationJob: jest.fn() }));
const mockOrdersFetch = jest.fn();
jest.unstable_mockModule('razorpay', () => ({
  default: jest.fn().mockImplementation(() => ({ orders: { fetch: mockOrdersFetch, create: jest.fn() } })),
}));
jest.unstable_mockModule('../../middleware/authMiddleware.js', () => ({
  protect: (req, res, next) => { req.user = { id: 7, role: req.headers['x-role'] || 'vendor' }; next(); },
}));

const { hashOTP } = await import('../../util/otp.js');
const { checkPayoutChange, payoutFieldsChanging } = await import('../../services/payoutChangeService.js');
const { requireApprovedVendor, vendorOnly } = await import('../../middleware/roleMiddleware.js');
const { SAFE_CUSTOMER_SELECT, SAFE_OWN_USER_SELECT } = await import('../../util/publicVendor.js');
const { verifyVendorPayment } = await import('../../controllers/vendor/paymentController.js');
const { resendWalkInJobNotification } = await import('../../controllers/vendor/walkInJobController.js');
const express = (await import('express')).default;
const request = (await import('supertest')).default;
const profileRoutes = (await import('../../routes/vendor/profile.js')).default;

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.set = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => jest.clearAllMocks());

describe('A-023 payout account change step-up', () => {
  const current = { bank_account_number: '111', ifsc_code: 'HDFC0001', onboarding_completed: true };
  const incoming = { bank_account_number: '999' };

  test('detects changes by trimmed value only', () => {
    expect(payoutFieldsChanging(current, { bank_account_number: ' 111 ' })).toBe(false);
    expect(payoutFieldsChanging(current, incoming)).toBe(true);
  });
  test('first-time setup (no fund account) needs no OTP and no hold', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue(null);
    expect(await checkPayoutChange(7, current, incoming, undefined)).toEqual({ ok: true, changed: false });
  });
  test('onboarding exception: no OTP, but hold + alert apply', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue({ vendorId: 7 });
    expect(await checkPayoutChange(7, { ...current, onboarding_completed: false }, incoming)).toEqual({ ok: true, changed: true });
  });
  test('onboarded vendor without OTP -> 403 PAYOUT_OTP_REQUIRED', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue({ vendorId: 7 });
    const r = await checkPayoutChange(7, current, incoming, '');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PAYOUT_OTP_REQUIRED');
  });
  test('wrong OTP -> 403 PAYOUT_OTP_INVALID', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue({ vendorId: 7 });
    mockPrisma.emailOTP.findFirst.mockResolvedValue({ id: 1, otp: hashOTP('123456'), failedAttempts: 0 });
    mockPrisma.emailOTP.updateMany.mockResolvedValue({ count: 1 });
    const r = await checkPayoutChange(7, current, incoming, '000000');
    expect(r.body.code).toBe('PAYOUT_OTP_INVALID');
  });
  test('correct OTP -> allowed, single use, purpose-scoped lookup', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue({ vendorId: 7 });
    mockPrisma.emailOTP.findFirst.mockResolvedValue({ id: 1, otp: hashOTP('123456'), failedAttempts: 0 });
    mockPrisma.emailOTP.updateMany.mockResolvedValue({ count: 1 });
    expect(await checkPayoutChange(7, current, incoming, '123456')).toEqual({ ok: true, changed: true });
    expect(mockPrisma.emailOTP.findFirst.mock.calls[0][0].where).toMatchObject({ userId: 7, purpose: 'payout_change' });
    expect(mockPrisma.emailOTP.deleteMany).toHaveBeenCalledWith({ where: { userId: 7, purpose: 'payout_change' } });
  });
});

describe('POST /accounts/vendor/profile/payout-otp is mounted', () => {
  const app = express();
  app.use(express.json());
  app.use('/accounts/vendor', profileRoutes);

  test('vendor gets a code emailed (stored hashed)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 7, email: 'v@example.com' });
    const r = await request(app).post('/accounts/vendor/profile/payout-otp');
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    const stored = mockPrisma.emailOTP.create.mock.calls[0][0].data;
    expect(stored).toMatchObject({ purpose: 'payout_change', userId: 7 });
    expect(stored.otp).toMatch(/^[0-9a-f]{64}$/);
    expect(mockSendEmail).toHaveBeenCalled();
  });
  test('non-vendor is refused (vendorOnly)', async () => {
    const r = await request(app).post('/accounts/vendor/profile/payout-otp').set('x-role', 'user');
    expect(r.status).toBe(403);
    expect(mockPrisma.emailOTP.create).not.toHaveBeenCalled();
  });
});

describe('A-020 role / approval middleware', () => {
  test('vendorOnly rejects a customer', () => {
    const res = mockRes(); const next = jest.fn();
    // vendorOnly sets 403 and throws; the error middleware renders it.
    expect(() => vendorOnly({ user: { id: 1, role: 'user' } }, res, next)).toThrow(/vendor/);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
  test('requireApprovedVendor blocks pending vendors with VENDOR_NOT_APPROVED', async () => {
    mockPrisma.vendorProfile.findUnique.mockResolvedValue({ status: 'pending' });
    const res = mockRes(); const next = jest.fn();
    await requireApprovedVendor({ user: { id: 7 } }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].code).toBe('VENDOR_NOT_APPROVED');
  });
  test('requireApprovedVendor lets approved vendors through', async () => {
    mockPrisma.vendorProfile.findUnique.mockResolvedValue({ status: 'approved' });
    const next = jest.fn();
    await requireApprovedVendor({ user: { id: 7 } }, mockRes(), next);
    expect(next).toHaveBeenCalledWith();
  });
});

describe('A-022 safe user selects', () => {
  test('never select password or push tokens', () => {
    for (const sel of [SAFE_CUSTOMER_SELECT, SAFE_OWN_USER_SELECT]) {
      const keys = JSON.stringify(sel);
      expect(keys).not.toMatch(/password|push_token|pushToken|fcm/i);
    }
  });
});

describe('A-017 / A-019 vendor payment verify', () => {
  const body = { orderId: 'order_1', paymentId: 'pay_1', gateway: 'razorpay' };
  const sign = (secret) => crypto.createHmac('sha256', secret).update('order_1|pay_1').digest('hex');
  const OLD = { ...process.env };
  afterEach(() => { process.env = { ...OLD }; });

  test('503 when gateway keys are missing (no placeholder fallback)', async () => {
    delete process.env.RAZORPAY_KEY_ID; delete process.env.RAZORPAY_KEY_SECRET;
    const res = mockRes();
    await verifyVendorPayment({ user: { id: 7 }, body: { ...body, signature: 'x' } }, res);
    expect(res.status).toHaveBeenCalledWith(503);
  });
  test("403 when the order was created for another vendor", async () => {
    process.env.RAZORPAY_KEY_ID = 'test_id'; process.env.RAZORPAY_KEY_SECRET = 'test_secret';
    mockOrdersFetch.mockResolvedValue({ amount: 50000, notes: { vendorId: '99', type: 'vendor_payment' } });
    const res = mockRes();
    await verifyVendorPayment({ user: { id: 7 }, body: { ...body, signature: sign('test_secret') } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockPrisma.payment.create).not.toHaveBeenCalled();
  });
  test('own order is recorded with vendorId; replay -> 409', async () => {
    process.env.RAZORPAY_KEY_ID = 'test_id'; process.env.RAZORPAY_KEY_SECRET = 'test_secret';
    mockOrdersFetch.mockResolvedValue({ amount: 50000, notes: { vendorId: '7', type: 'vendor_payment' } });
    mockPrisma.payment.create.mockResolvedValueOnce({ id: 1 });
    await verifyVendorPayment({ user: { id: 7 }, body: { ...body, signature: sign('test_secret') } }, mockRes());
    expect(mockPrisma.payment.create.mock.calls[0][0].data.vendorId).toBe(7);

    mockPrisma.payment.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }));
    const res = mockRes();
    await verifyVendorPayment({ user: { id: 7 }, body: { ...body, signature: sign('test_secret') } }, res);
    expect(res.status).toHaveBeenCalledWith(409);
  });
});

describe('A-024 walk-in notification cooldown', () => {
  test('a re-send inside the cooldown is 429 with Retry-After', async () => {
    mockPrisma.walkInJob.findFirst.mockResolvedValue({ id: 3, vendorId: 7, lastNotifiedAt: new Date() });
    const res = mockRes();
    await resendWalkInJobNotification({ user: { id: 7 }, params: { id: '3' } }, res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
    expect(mockPrisma.walkInJob.updateMany).not.toHaveBeenCalled();
  });
  test('a concurrent tap that loses the atomic claim is 429', async () => {
    mockPrisma.walkInJob.findFirst.mockResolvedValue({ id: 3, vendorId: 7, lastNotifiedAt: null });
    mockPrisma.walkInJob.updateMany.mockResolvedValue({ count: 0 });
    const res = mockRes();
    await resendWalkInJobNotification({ user: { id: 7 }, params: { id: '3' } }, res);
    expect(res.status).toHaveBeenCalledWith(429);
  });
});
