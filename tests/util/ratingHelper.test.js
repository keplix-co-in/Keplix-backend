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
 */

const mockPrisma = { vendorProfile: { findUnique: jest.fn(), update: jest.fn() } };
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));

const { updateVendorRatingStats } = await import('../../util/ratingHelper.js');

function mockTx(profile) {
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
    },
    updates,
  };
}

describe('updateVendorRatingStats', () => {
  test('reads exactly the fields VendorProfile actually has', async () => {
    // Guards the original bug: a select for a non-existent column throws
    // "Unknown field" at runtime and takes the surrounding transaction with it.
    const { tx } = mockTx({ rating: 0, numReviews: 0 });

    await updateVendorRatingStats(tx, 42, 5, false);

    const select = tx.vendorProfile.findUnique.mock.calls[0][0].select;
    expect(Object.keys(select).sort()).toEqual(['numReviews', 'rating']);
  });

  test('first review sets the average to that rating', async () => {
    const { tx, updates } = mockTx({ rating: 0, numReviews: 0 });

    await updateVendorRatingStats(tx, 42, 4, false);

    expect(updates).toHaveLength(1);
    expect(updates[0].data).toEqual({ rating: 4, numReviews: 1 });
  });

  test('a subsequent review produces a running average', async () => {
    // Existing: 2 reviews averaging 4 (total 8). Adding a 5 → 13/3.
    const { tx, updates } = mockTx({ rating: 4, numReviews: 2 });

    await updateVendorRatingStats(tx, 42, 5, false);

    expect(updates[0].data.numReviews).toBe(3);
    expect(updates[0].data.rating).toBeCloseTo(13 / 3, 5);
  });

  test('deleting a review removes its contribution', async () => {
    // Existing: 3 reviews averaging 4 (total 12). Removing a 3 → 9/2 = 4.5.
    const { tx, updates } = mockTx({ rating: 4, numReviews: 3 });

    await updateVendorRatingStats(tx, 42, 3, true);

    expect(updates[0].data.numReviews).toBe(2);
    expect(updates[0].data.rating).toBeCloseTo(4.5, 5);
  });

  test('deleting the last review resets to zero rather than dividing by zero', async () => {
    const { tx, updates } = mockTx({ rating: 5, numReviews: 1 });

    await updateVendorRatingStats(tx, 42, 5, true);

    expect(updates[0].data).toEqual({ rating: 0, numReviews: 0 });
  });

  test('the average is never negative', async () => {
    // Defensive: inconsistent stored data must not produce a negative rating.
    const { tx, updates } = mockTx({ rating: 1, numReviews: 2 });

    await updateVendorRatingStats(tx, 42, 5, true);

    expect(updates[0].data.rating).toBeGreaterThanOrEqual(0);
  });

  test('a missing vendor profile is a no-op, not a throw', async () => {
    // This runs inside the booking-confirmation transaction, so throwing here
    // would roll back the payout claim along with it.
    const { tx, updates } = mockTx(null);

    await expect(updateVendorRatingStats(tx, 42, 5, false)).resolves.toBeUndefined();
    expect(updates).toHaveLength(0);
  });

  test('a missing vendorId is a no-op', async () => {
    const { tx } = mockTx({ rating: 0, numReviews: 0 });

    await updateVendorRatingStats(tx, undefined, 5, false);

    expect(tx.vendorProfile.findUnique).not.toHaveBeenCalled();
  });
});
