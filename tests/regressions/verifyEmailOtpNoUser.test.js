/**
 * Regression test: POST /accounts/auth/verify-email-otp must not 500 when the
 * OTP's email has no matching User row yet.
 *
 * sendEmailOTP accepts any email address and creates an EmailOTP record for
 * it without requiring a User to exist -- it's also used to verify an address
 * before/independent of a full signup. verifyEmailOTP then unconditionally
 * did `prisma.user.update({ where: { email }, ... })` to mark the user
 * verified; Prisma's `update()` throws P2025 ("record not found") when no row
 * matches, turning a perfectly valid OTP verification into a 500
 * {"message":"OTP Verification Failed"} for any email not yet tied to a User.
 *
 * Found by the auth audit flow test (tests/audit/auth.flow.mjs, 2026-09-28)
 * against a real database. Fixed by switching to `updateMany`, which performs
 * the same write but is a no-op (count 0) instead of throwing when nothing
 * matches.
 */
import { jest } from '@jest/globals';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-verify-email-otp-spec';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-for-verify-email-otp-spec';

const record = {
  id: 'otp-1',
  email: 'nouser@test.local',
  otp: '123456',
  verified: false,
  expiresAt: new Date(Date.now() + 60_000),
};

const emailOTP = {
  findFirst: jest.fn().mockResolvedValue(record),
  update: jest.fn().mockResolvedValue({ ...record, verified: true }),
};

// No User row exists for this email: findUnique resolves null, and a
// P2025-throwing update() is what the pre-fix code called directly.
const userUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
const userFindUnique = jest.fn().mockResolvedValue(null);

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    emailOTP,
    user: {
      updateMany: userUpdateMany,
      findUnique: userFindUnique,
      update: jest.fn().mockImplementation(() => {
        // Mirrors real Prisma behavior: update() on a non-existent row throws.
        const err = new Error('No record was found for an update.');
        err.code = 'P2025';
        return Promise.reject(err);
      }),
    },
    vendorProfile: { create: jest.fn() },
    userProfile: { create: jest.fn() },
  },
}));

const { verifyEmailOTP } = await import('../../controllers/authController.js');

const makeRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('verifyEmailOTP with no matching User', () => {
  beforeEach(() => {
    userUpdateMany.mockClear();
  });

  it('returns 200 instead of 500 when the email has no User row yet', async () => {
    const res = makeRes();
    await verifyEmailOTP({ body: { email: record.email, otp: record.otp } }, res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, message: 'Email OTP verified successfully' })
    );
  });

  it('uses updateMany (never throws on zero matches), not update', async () => {
    const res = makeRes();
    await verifyEmailOTP({ body: { email: record.email, otp: record.otp } }, res);

    expect(userUpdateMany).toHaveBeenCalledWith({
      where: { email: record.email },
      data: { is_verified: true },
    });
  });
});
