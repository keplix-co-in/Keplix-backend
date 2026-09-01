import { jest } from '@jest/globals';

/**
 * Tests for resolvePlatformFeeRate in util/platformSettings.js.
 *
 * This resolver is what makes the admin commission toggle real. Before it,
 * PlatformSettings.isPlatformFeeEnabled / platformFeePercentage existed in the
 * schema, the validator and the admin PATCH endpoint, but nothing read them —
 * services/paymentService.js used a hardcoded `PLATFORM_FEE_PERCENTAGE = 0.1`,
 * so flipping the switch in the admin panel changed nothing about the money.
 *
 * The cases below pin the two directions that actually matter financially:
 * a switched-off fee must pay the vendor 100%, and an ABSENT settings row must
 * NOT be read as "fee off" — that would silently waive the platform's entire
 * revenue on a fresh database.
 */

const mockPrisma = { platformSettings: { findFirst: jest.fn() } };
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));

const { resolvePlatformFeeRate } = await import('../../util/platformSettings.js');

describe('resolvePlatformFeeRate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns the configured rate when the fee is enabled', async () => {
    mockPrisma.platformSettings.findFirst.mockResolvedValue({
      isPlatformFeeEnabled: true,
      platformFeePercentage: 0.1,
    });

    expect(await resolvePlatformFeeRate()).toBe(0.1);
  });

  test('honours a custom rate rather than assuming 10%', async () => {
    mockPrisma.platformSettings.findFirst.mockResolvedValue({
      isPlatformFeeEnabled: true,
      platformFeePercentage: 0.175,
    });

    expect(await resolvePlatformFeeRate()).toBe(0.175);
  });

  test('returns 0 when the fee is switched off — the vendor keeps 100%', async () => {
    mockPrisma.platformSettings.findFirst.mockResolvedValue({
      isPlatformFeeEnabled: false,
      platformFeePercentage: 0.1,
    });

    expect(await resolvePlatformFeeRate()).toBe(0);
  });

  test('a 0% configured rate is honoured even with the fee nominally enabled', async () => {
    mockPrisma.platformSettings.findFirst.mockResolvedValue({
      isPlatformFeeEnabled: true,
      platformFeePercentage: 0,
    });

    expect(await resolvePlatformFeeRate()).toBe(0);
  });

  /**
   * The important one. PlatformSettings is a singleton that is NOT guaranteed
   * to have a row (util/platformSettings.js says so explicitly, and production
   * was confirmed empty during the health-sheet migration). Treating a missing
   * row as "no fee" would zero the platform's revenue the first time this ran
   * against a fresh database, silently.
   */
  test('falls back to the default rate when no settings row exists — never to 0', async () => {
    mockPrisma.platformSettings.findFirst.mockResolvedValue(null);

    expect(await resolvePlatformFeeRate()).toBe(0.1);
  });

  test.each([
    ['negative', -0.5],
    ['greater than 100%', 1.5],
    ['not a number', 'ten percent'],
    ['NaN', NaN],
  ])('falls back to the default when the stored rate is %s', async (_label, stored) => {
    mockPrisma.platformSettings.findFirst.mockResolvedValue({
      isPlatformFeeEnabled: true,
      platformFeePercentage: stored,
    });

    // A negative rate would pay the vendor MORE than was collected; a rate
    // above 1 would make vendorAmount negative. Neither may reach the money.
    expect(await resolvePlatformFeeRate()).toBe(0.1);
  });

  test('the off-switch wins over an out-of-range stored rate', async () => {
    mockPrisma.platformSettings.findFirst.mockResolvedValue({
      isPlatformFeeEnabled: false,
      platformFeePercentage: -1,
    });

    expect(await resolvePlatformFeeRate()).toBe(0);
  });
});
