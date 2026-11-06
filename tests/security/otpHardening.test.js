/**
 * Security O-001 / O-005 / A-003: OTP hardening.
 *
 * - codes are stored as an HMAC, never plaintext (O-005)
 * - comparison is constant-time and a legacy plaintext row never verifies
 * - every code allows at most OTP_MAX_ATTEMPTS guesses, then is deleted (O-001)
 * - verify routes carry a per-identifier limiter keyed on the email/phone
 * - garage claim verify rejects an already-used code (A-003)
 */
import { jest } from '@jest/globals';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-otp-hardening';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-otp-hardening';

const prismaMock = {
  emailOTP: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn(), create: jest.fn() },
  phoneOTP: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn(), upsert: jest.fn() },
  user: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  $transaction: jest.fn(),
};
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: prismaMock }));
// Never let a unit test reach a real email/SMS provider.
const resendSend = jest.fn().mockResolvedValue({ id: 'test' });
jest.unstable_mockModule('../../util/resend.js', () => ({ resend: { emails: { send: resendSend } } }));
jest.unstable_mockModule('../../util/communication.js', () => ({
  sendEmail: jest.fn(), sendSMS: jest.fn(), sendWhatsApp: jest.fn(), sendPushNotification: jest.fn(),
}));

const otp = await import('../../util/otp.js');
const { hashOTP, verifyOTP, consumeOtpAttempt, OTP_MAX_ATTEMPTS } = otp;
const { __otpIdentifierKeyForTests: keyOf } = await import('../../middleware/rateLimitMiddleware.js');

const makeDelegate = (row) => {
  const state = { ...row };
  return {
    state,
    updateMany: jest.fn(async ({ where }) => {
      if (state.deleted || state.failedAttempts >= where.failedAttempts.lt) return { count: 0 };
      state.failedAttempts += 1;
      return { count: 1 };
    }),
    deleteMany: jest.fn(async () => { state.deleted = true; return { count: 1 }; }),
  };
};

describe('hashOTP / verifyOTP (O-005)', () => {
  test('stored value is a 64-char HMAC, not the code', () => {
    const h = hashOTP('123456');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('123456');
    expect(hashOTP(123456)).toBe(h);
  });

  test('verifies the right code and rejects a wrong one', () => {
    const h = hashOTP('654321');
    expect(verifyOTP('654321', h)).toBe(true);
    expect(verifyOTP(' 654321 ', h)).toBe(true);
    expect(verifyOTP('654320', h)).toBe(false);
  });

  test('legacy plaintext rows never verify and never throw', () => {
    expect(verifyOTP('123456', '123456')).toBe(false);
    expect(verifyOTP(undefined, hashOTP('1'))).toBe(false);
    expect(verifyOTP('1', null)).toBe(false);
  });
});

describe('consumeOtpAttempt (O-001)', () => {
  test('correct code on first try succeeds', async () => {
    const d = makeDelegate({ id: 1, otp: hashOTP('111111'), failedAttempts: 0 });
    await expect(consumeOtpAttempt(d, d.state, '111111')).resolves.toEqual({ ok: true });
  });

  test('wrong guesses count down, then the row is deleted', async () => {
    const d = makeDelegate({ id: 1, otp: hashOTP('111111'), failedAttempts: 0 });
    for (let i = 1; i < OTP_MAX_ATTEMPTS; i++) {
      const r = await consumeOtpAttempt(d, { ...d.state, failedAttempts: i - 1 }, '000000');
      expect(r).toEqual({ ok: false, locked: false, attemptsLeft: OTP_MAX_ATTEMPTS - i });
    }
    const last = await consumeOtpAttempt(d, { ...d.state, failedAttempts: OTP_MAX_ATTEMPTS - 1 }, '000000');
    expect(last).toEqual({ ok: false, locked: true, attemptsLeft: 0 });
    expect(d.deleteMany).toHaveBeenCalled();
  });

  test('even the correct code fails once attempts are exhausted', async () => {
    const d = makeDelegate({ id: 1, otp: hashOTP('111111'), failedAttempts: OTP_MAX_ATTEMPTS });
    const r = await consumeOtpAttempt(d, d.state, '111111');
    expect(r.ok).toBe(false);
    expect(r.locked).toBe(true);
  });

  test('parallel guesses cannot exceed the cap', async () => {
    const d = makeDelegate({ id: 1, otp: hashOTP('111111'), failedAttempts: 0 });
    const snapshot = { ...d.state };
    await Promise.all(Array.from({ length: 50 }, () => consumeOtpAttempt(d, snapshot, '000000')));
    expect(d.state.failedAttempts).toBe(OTP_MAX_ATTEMPTS);
  });
});

describe('otpVerifyLimiter key (O-001)', () => {
  test('keys on normalized email, then phone, then IP', () => {
    expect(keyOf({ body: { email: ' A@B.com ' }, ip: '1.1.1.1' })).toBe('otp:e:a@b.com');
    expect(keyOf({ body: { phone_number: '9876543210' }, ip: '1.1.1.1' })).toMatch(/^otp:p:/);
    expect(keyOf({ body: { phone_number: '9876543210' }, ip: '1.1.1.1' }))
      .toBe(keyOf({ body: { phone: '+91 98765 43210' }, ip: '2.2.2.2' }));
    expect(keyOf({ body: {}, ip: '1.1.1.1' })).toMatch(/^otp:ip:/);
  });
});

describe('verify routes mount the per-identifier limiter', () => {
  test('auth OTP verify routes and garage claim verify', async () => {
    const fs = await import('fs');
    const auth = fs.readFileSync(new URL('../../routes/auth.js', import.meta.url), 'utf8');
    for (const route of ['/reset-password-otp', '/verify-phone-otp', '/verify-email-otp']) {
      const line = auth.split(/\r?\n/).find((l) => l.includes(`'${route}'`) && l.includes('router.post'));
      expect(line).toContain('otpVerifyLimiter');
    }
    const garage = fs.readFileSync(new URL('../../routes/user/garage.js', import.meta.url), 'utf8');
    const line = garage.split(/\r?\n/).find((l) => l.includes("'/garage/claim/verify'"));
    expect(line).toContain('claimVerifyLimiter');
    expect(line).toContain('otpVerifyLimiter');
  });
});

const makeRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const auth = await import('../../controllers/authController.js');
const garage = await import('../../controllers/user/garageController.js');

describe('controllers enforce hashing and the attempt cap', () => {
  beforeEach(() => jest.clearAllMocks());

  test('sendEmailOTP stores an HMAC, not the code', async () => {
    prismaMock.emailOTP.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.emailOTP.create.mockResolvedValue({ id: 9 });
    await auth.sendEmailOTP({ body: { email: 'x@y.com' } }, makeRes());
    const stored = prismaMock.emailOTP.create.mock.calls[0][0].data.otp;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });

  test('verifyEmailOTP returns OTP_INVALID on a wrong guess', async () => {
    prismaMock.emailOTP.findFirst.mockResolvedValue({
      id: 1, email: 'x@y.com', otp: hashOTP('222222'), failedAttempts: 0, verified: false,
      expiresAt: new Date(Date.now() + 60_000),
    });
    prismaMock.emailOTP.updateMany.mockResolvedValue({ count: 1 });
    const res = makeRes();
    await auth.verifyEmailOTP({ body: { email: 'x@y.com', otp: '111111' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'OTP_INVALID' }));
    expect(prismaMock.emailOTP.update).not.toHaveBeenCalled();
  });

  test('verifyPhoneOTP locks after the last attempt and deletes the row', async () => {
    prismaMock.phoneOTP.findUnique.mockResolvedValue({
      id: 2, phone_number: '+919876543210', otp: hashOTP('222222'),
      failedAttempts: OTP_MAX_ATTEMPTS - 1, verified: false, expiresAt: new Date(Date.now() + 60_000),
    });
    prismaMock.phoneOTP.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.phoneOTP.deleteMany.mockResolvedValue({ count: 1 });
    const res = makeRes();
    await auth.verifyPhoneOTP({ body: { phone_number: '9876543210', otp: '111111' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'OTP_ATTEMPTS_EXCEEDED' }));
    expect(prismaMock.phoneOTP.deleteMany).toHaveBeenCalledWith({ where: { id: 2 } });
  });

  test('garage claimVerify rejects an already-verified code (A-003)', async () => {
    prismaMock.phoneOTP.findUnique.mockResolvedValue({
      id: 3, phone_number: '+919876543210', otp: hashOTP('222222'), failedAttempts: 0,
      verified: true, expiresAt: new Date(Date.now() + 60_000),
    });
    const res = makeRes();
    await garage.claimVerify({ body: { phone: '+919876543210', otp: '222222' }, user: { id: 5 } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(prismaMock.phoneOTP.updateMany).not.toHaveBeenCalled();
  });

  test('garage claimVerify spends an attempt on a wrong code (A-003)', async () => {
    prismaMock.phoneOTP.findUnique.mockResolvedValue({
      id: 3, phone_number: '+919876543210', otp: hashOTP('222222'), failedAttempts: 0,
      verified: false, expiresAt: new Date(Date.now() + 60_000),
    });
    prismaMock.phoneOTP.updateMany.mockResolvedValue({ count: 1 });
    const res = makeRes();
    await garage.claimVerify({ body: { phone: '+919876543210', otp: '000000' }, user: { id: 5 } }, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'OTP_INVALID' }));
    expect(prismaMock.phoneOTP.updateMany).toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
