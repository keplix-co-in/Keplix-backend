/**
 * Regression test for the CONFIRMED PhoneOTP retention gap, found by the
 * 2026-09-12 codebase audit (compliance-auditor F49, corroborated by
 * security-auditor).
 *
 * pruneExpiredRecords already pruned EmailOTP on the same schedule
 * (expired, or verified past a 24h retention window) but never touched
 * PhoneOTP, which has the exact same shape (expiresAt/verified/createdAt).
 * Every phone number that ever requested an OTP, and the code sent to it,
 * was retained indefinitely.
 *
 * See tests/regressions/bookingStatusGuards.test.js for the file convention.
 */
import { jest } from '@jest/globals';

const mockPrisma = {
  emailOTP: { deleteMany: jest.fn() },
  phoneOTP: { deleteMany: jest.fn() },
  blacklistedToken: { deleteMany: jest.fn() },
};

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../util/logger.js', () => ({
  default: { info: jest.fn(), error: jest.fn() },
}));

const { pruneExpiredRecords } = await import('../../queues/otpCleanupQueue.js');

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.emailOTP.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.phoneOTP.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.blacklistedToken.deleteMany.mockResolvedValue({ count: 0 });
});

describe('PhoneOTP pruning — FIXED, regression guard', () => {
  test('prunes PhoneOTP on the same expired-or-verified-past-retention rule as EmailOTP', async () => {
    mockPrisma.phoneOTP.deleteMany.mockResolvedValue({ count: 3 });

    const result = await pruneExpiredRecords();

    expect(mockPrisma.phoneOTP.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { expiresAt: { lt: expect.any(Date) } },
          { verified: true, createdAt: { lt: expect.any(Date) } },
        ],
      },
    });
    expect(result.phoneOtps).toBe(3);
  });

  test('still prunes EmailOTP and BlacklistedToken as before', async () => {
    mockPrisma.emailOTP.deleteMany.mockResolvedValue({ count: 2 });
    mockPrisma.blacklistedToken.deleteMany.mockResolvedValue({ count: 1 });

    const result = await pruneExpiredRecords();

    expect(mockPrisma.emailOTP.deleteMany).toHaveBeenCalled();
    expect(mockPrisma.blacklistedToken.deleteMany).toHaveBeenCalled();
    expect(result).toEqual({ otps: 2, phoneOtps: 0, tokens: 1 });
  });
});
