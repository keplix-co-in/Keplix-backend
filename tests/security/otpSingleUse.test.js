/**
 * OTP single-use race: two concurrent requests carrying the same correct code
 * must not both succeed. claimOtp() flips verified false->true with a
 * conditional updateMany; only count === 1 may proceed.
 */
import { jest } from '@jest/globals';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-otp-single-use';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-otp-single-use';

const mockPrisma = {
  emailOTP: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn(), create: jest.fn() },
  phoneOTP: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() },
  user: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  vendorPayoutAccount: { findUnique: jest.fn() },
  $transaction: jest.fn(),
};
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../util/resend.js', () => ({ resend: { emails: { send: jest.fn() } } }));
jest.unstable_mockModule('../../util/communication.js', () => ({
  sendEmail: jest.fn(), sendSMS: jest.fn(), sendWhatsApp: jest.fn(), sendPushNotification: jest.fn(), redactForLog: (x) => x,
}));
jest.unstable_mockModule('../../util/notificationHelper.js', () => ({ createNotification: jest.fn() }));

const { hashOTP, claimOtp } = await import('../../util/otp.js');
const { checkPayoutChange } = await import('../../services/payoutChangeService.js');
const auth = await import('../../controllers/authController.js');

const makeRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.cookie = jest.fn().mockReturnValue(res);
  return res;
};

// Stateful fake of the OTP table honouring the conditional wheres used by
// consumeOtpAttempt (failedAttempts < N) and claimOtp (verified: false).
const installRow = (delegate, row) => {
  const state = { failedAttempts: 0, verified: false, ...row };
  delegate.updateMany.mockImplementation(async ({ where, data }) => {
    if (where.id !== state.id || state.deleted) return { count: 0 };
    if (where.verified === false) {
      if (state.verified) return { count: 0 };
      state.verified = true;
      return { count: 1 };
    }
    if (state.failedAttempts >= where.failedAttempts.lt) return { count: 0 };
    state.failedAttempts += data.failedAttempts.increment;
    return { count: 1 };
  });
  delegate.deleteMany.mockResolvedValue({ count: 1 });
  return state;
};

beforeEach(() => jest.clearAllMocks());

describe('claimOtp', () => {
  test('only the first claim wins', async () => {
    installRow(mockPrisma.emailOTP, { id: 1 });
    const results = await Promise.all([claimOtp(mockPrisma.emailOTP, 1), claimOtp(mockPrisma.emailOTP, 1)]);
    expect(results.sort()).toEqual([false, true]);
    expect(mockPrisma.emailOTP.updateMany).toHaveBeenCalledWith({ where: { id: 1, verified: false }, data: { verified: true } });
  });
});

describe('payout-change OTP is atomically single-use', () => {
  test('two concurrent profile writes with the same code: exactly one passes', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue({ vendorId: 7 });
    const row = { id: 5, otp: hashOTP('123456'), failedAttempts: 0, verified: false };
    mockPrisma.emailOTP.findFirst.mockResolvedValue(row);
    installRow(mockPrisma.emailOTP, row);
    const current = { bank_account_number: '111', onboarding_completed: true };
    const [a, b] = await Promise.all([
      checkPayoutChange(7, current, { bank_account_number: '999' }, '123456'),
      checkPayoutChange(7, current, { bank_account_number: '888' }, '123456'),
    ]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect([a, b].find((r) => !r.ok).body.code).toBe('PAYOUT_OTP_INVALID');
  });
});

describe('auth OTP verify paths stop when the claim is lost', () => {
  const future = () => new Date(Date.now() + 60_000);

  test('verifyEmailOTP (login) -> 400 OTP already used, user untouched', async () => {
    const row = { id: 2, email: 'x@y.com', otp: hashOTP('222222'), expiresAt: future() };
    mockPrisma.emailOTP.findFirst.mockResolvedValue(row);
    const state = installRow(mockPrisma.emailOTP, row);
    state.verified = true; // a concurrent request already claimed it
    const res = makeRes();
    await auth.verifyEmailOTP({ body: { email: 'x@y.com', otp: '222222' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'OTP already used' });
    expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
  });

  test('verifyPhoneOTP -> 400, row not re-marked', async () => {
    const row = { id: 3, phone_number: '+919876543210', otp: hashOTP('333333'), expiresAt: future() };
    mockPrisma.phoneOTP.findUnique.mockResolvedValue(row);
    const state = installRow(mockPrisma.phoneOTP, row);
    state.verified = true;
    const res = makeRes();
    await auth.verifyPhoneOTP({ body: { phone_number: '9876543210', otp: '333333' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'OTP already verified' });
    expect(mockPrisma.phoneOTP.update).not.toHaveBeenCalled();
  });

  test('resetPasswordWithOTP -> 400, password not changed', async () => {
    const row = { id: 4, email: 'x@y.com', otp: hashOTP('444444'), expiresAt: future() };
    mockPrisma.emailOTP.findFirst.mockResolvedValue(row);
    mockPrisma.user.findUnique.mockResolvedValue({ id: 9, email: 'x@y.com' });
    const state = installRow(mockPrisma.emailOTP, row);
    state.verified = true;
    const res = makeRes();
    await auth.resetPasswordWithOTP({ body: { email: 'x@y.com', otp: '444444', password: 'NewPassw0rd!' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  test('verifyEmailChange: concurrent requests -> exactly one email update', async () => {
    const row = { id: 6, email: 'new@y.com', otp: hashOTP('666666'), expiresAt: future() };
    mockPrisma.emailOTP.findFirst.mockResolvedValue(row);
    installRow(mockPrisma.emailOTP, row);
    mockPrisma.user.update.mockResolvedValue({});
    const req = () => ({ user: { id: 9, email: 'old@y.com' }, body: { new_email: 'new@y.com', otp: '666666' } });
    const r1 = makeRes();
    const r2 = makeRes();
    await Promise.all([auth.verifyEmailChange(req(), r1), auth.verifyEmailChange(req(), r2)]);
    expect(mockPrisma.user.update).toHaveBeenCalledTimes(1);
    expect([r1, r2].map((r) => r.status.mock.calls[0]?.[0])).toContain(400);
  });
});
