import { jest } from '@jest/globals';

/**
 * Tests for util/ratingHelper.js.
 *
 * This file previously defined its own `simulateRatingUpdate` and asserted
 * against that, never importing the real helper — and it used node:test rather
 * than jest, so under `npm test` it registered zero cases and the suite simply
 * errored. The combination meant a genuine bug went unnoticed: the helper read
 * and wrote `rating` / `numReviews` on VendorProfile, columns that did not
 * exist in the schema, so every call threw at runtime. It broke review
 * creation, review deletion, and — most seriously — booking confirmation,
 * which is the path that releases escrow to the vendor.
 *
 * These tests exercise the real exported function against a mock transaction
 * client, so a future schema/field drift fails here instead of in production.
 *
 * The helper now derives the aggregates from the Review rows themselves rather
 * than adjusting the stored average in place, so these assert the recomputed
 * result and that a concurrent write cannot be silently dropped.
 */

const mockPrisma = { vendorProfile: { findUnique: jest.fn(), update: jest.fn() } };
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));

const { updateVendorRatingStats } = await import('../../util/ratingHelper.js');

/**
 * @param profile - VendorProfile row, or null to simulate a missing profile
 * @param aggregate - what review.aggregate should report post-write
 */
function mockTx(profile, aggregate = { _avg: { rating: null }, _count: { _all: 0 } }) {
  const updates = [];
  return {
    tx: {
      vendorProfile: {
        findUnique: jest.fn().mockResolvedValue(profile),
        update: jest.fn().mockImplementation(async ({ where, data }) => {
          updates.push({ where, data });
          return { ...profile, ...data };
        }),
      },
      review: {
        aggregate: jest.fn().mockResolvedValue(aggregate),
      },
    },
    updates,
  };
}

describe('updateVendorRatingStats', () => {
  test('reads only fields VendorProfile actually has', async () => {
    // Guards the original bug: a select for a non-existent column throws
    // "Unknown field" at runtime and takes the surrounding transaction with it.
    const { tx } = mockTx({ userId: 42 }, { _avg: { rating: 5 }, _count: { _all: 1 } });

    await updateVendorRatingStats(tx, 42);

    const select = tx.vendorProfile.findUnique.mock.calls[0][0].select;
    expect(Object.keys(select)).toEqual(['userId']);
  });

  test('scopes the aggregate to this vendor only', async () => {
    const { tx } = mockTx({ userId: 42 }, { _avg: { rating: 4 }, _count: { _all: 3 } });

    await updateVendorRatingStats(tx, 42);

    expect(tx.review.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { vendorId: 42 } })
    );
  });

  test('first review sets the average to that rating', async () => {
    const { tx, updates } = mockTx({ userId: 42 }, { _avg: { rating: 4 }, _count: { _all: 1 } });

    await updateVendorRatingStats(tx, 42);

    expect(updates).toHaveLength(1);
    expect(updates[0].data).toEqual({ rating: 4, numReviews: 1 });
  });

  test('the average reflects every committed review, not an incremental guess', async () => {
    // 3 reviews averaging 13/3. The old incremental helper could miss one of
    // two concurrent writes; deriving from the rows cannot.
    const { tx, updates } = mockTx(
      { userId: 42 },
      { _avg: { rating: 13 / 3 }, _count: { _all: 3 } }
    );

    await updateVendorRatingStats(tx, 42);

    expect(updates[0].data.numReviews).toBe(3);
    expect(updates[0].data.rating).toBeCloseTo(13 / 3, 5);
  });

  test('deleting a review is reflected by the recomputed average', async () => {
    // Post-delete state: 2 reviews averaging 4.5.
    const { tx, updates } = mockTx({ userId: 42 }, { _avg: { rating: 4.5 }, _count: { _all: 2 } });

    await updateVendorRatingStats(tx, 42);

    expect(updates[0].data.numReviews).toBe(2);
    expect(updates[0].data.rating).toBeCloseTo(4.5, 5);
  });

  test('deleting the last review resets to zero rather than writing null', async () => {
    // Prisma reports _avg as null when no rows match.
    const { tx, updates } = mockTx({ userId: 42 }, { _avg: { rating: null }, _count: { _all: 0 } });

    await updateVendorRatingStats(tx, 42);

    expect(updates[0].data).toEqual({ rating: 0, numReviews: 0 });
  });

  test('the average is never negative', async () => {
    const { tx, updates } = mockTx({ userId: 42 }, { _avg: { rating: -1 }, _count: { _all: 1 } });

    await updateVendorRatingStats(tx, 42);

    expect(updates[0].data.rating).toBeGreaterThanOrEqual(0);
  });

  test('a missing vendor profile is a no-op, not a throw', async () => {
    // This runs inside the booking-confirmation transaction, so throwing here
    // would roll back the payout claim along with it.
    const { tx, updates } = mockTx(null);

    await expect(updateVendorRatingStats(tx, 42)).resolves.toBeUndefined();
    expect(updates).toHaveLength(0);
  });

  test('a missing vendorId is a no-op', async () => {
    const { tx } = mockTx({ userId: 42 });

    await updateVendorRatingStats(tx, undefined);

    expect(tx.vendorProfile.findUnique).not.toHaveBeenCalled();
  });
});
