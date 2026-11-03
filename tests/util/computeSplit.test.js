import { jest } from '@jest/globals';

/**
 * computeSplit is the one place a payment is split into Keplix's fee and the
 * vendor's share (verify, the webhook and reconciliation all use it). The
 * fee is rounded to the paisa and the vendor gets exactly the rest, so the
 * ledger always matches the whole paise the payout sends.
 */

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: {} }));
const { computeSplit } = await import('../../util/platformSettings.js');

describe('computeSplit', () => {
  test('₹1000 at 10%: Keplix ₹100, vendor ₹900 (90000 paise)', () => {
    const s = computeSplit(1000, 0.1);
    expect(s).toEqual({ platformFee: 100, vendorAmount: 900 });
    expect(Math.round(s.vendorAmount * 100)).toBe(90000);
  });

  test('₹999.99 at 10% rounds the fee to the paisa and gives the vendor the rest', () => {
    // Before: fee 99.999, vendor 899.991 -- fractions of a paisa.
    expect(computeSplit(999.99, 0.1)).toEqual({ platformFee: 100, vendorAmount: 899.99 });
  });

  test('fee + vendor share always equals the amount, to the paisa', () => {
    for (const amount of [1, 1.01, 49.99, 333.33, 1234.56, 99999.99]) {
      const { platformFee, vendorAmount } = computeSplit(amount, 0.1);
      expect(Math.round(platformFee * 100) + Math.round(vendorAmount * 100)).toBe(Math.round(amount * 100));
    }
  });

  test('fee switched off: the vendor gets 100%', () => {
    expect(computeSplit(1000, 0)).toEqual({ platformFee: 0, vendorAmount: 1000 });
  });
});
