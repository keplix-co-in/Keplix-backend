import { jest } from '@jest/globals';

// Fee-on-top (2026-11-06): pure money helpers + the shared expected-charge
// resolver used by verify, the webhook and reconciliation.
const mockPrisma = { platformSettings: { findFirst: jest.fn() } };
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));

const { computeCharge, computeSplit } = await import('../../util/platformSettings.js');
const { resolveExpectedCharge, refundableBase, FEE_MODEL_ON_TOP } = await import('../../util/paymentCharge.js');

const booking = (price) => ({ service: { price: String(price) }, bookingVehicle: null });

beforeEach(() => {
  mockPrisma.platformSettings.findFirst.mockResolvedValue({ isPlatformFeeEnabled: true, platformFeePercentage: 0.1 });
});

describe('computeCharge', () => {
  test('adds the fee on top; vendor price unchanged', () => {
    expect(computeCharge(1000, 0.1)).toEqual({ servicePrice: 1000, platformFee: 100, feeRate: 0.1, total: 1100 });
  });
  test('rounds the fee to the paisa and price + fee === total exactly', () => {
    const c = computeCharge(999.99, 0.1); // 99.999 -> 100.00
    expect(c.platformFee).toBe(100);
    expect(c.total).toBe(1099.99);
    const d = computeCharge(0.05, 0.1); // 0.5 paise rounds half-up to 1 paisa
    expect(d.platformFee).toBe(0.01);
    const e = computeCharge(333.33, 0.075); // 24.99975 -> 25.00
    expect(e).toMatchObject({ platformFee: 25, total: 358.33 });
    expect(Math.round(e.servicePrice * 100) + Math.round(e.platformFee * 100)).toBe(Math.round(e.total * 100));
  });
  test('rate 0 (fee disabled) charges the price only', () => {
    expect(computeCharge(500, 0)).toEqual({ servicePrice: 500, platformFee: 0, feeRate: 0, total: 500 });
  });
  test('computeSplit (legacy) is unchanged', () => {
    expect(computeSplit(1000, 0.1)).toEqual({ platformFee: 100, vendorAmount: 900 });
  });
});

describe('refundableBase', () => {
  test('on_top: amount minus the kept fee', () => {
    expect(refundableBase({ amount: '1100', platformFee: '100', feeModel: 'on_top' })).toBe(1000);
  });
  test('legacy: the whole amount, even with a fee recorded', () => {
    expect(refundableBase({ amount: '1000', platformFee: '100', feeModel: null })).toBe(1000);
  });
});

describe('resolveExpectedCharge', () => {
  test('on_top notes: uses the frozen fee, vendor gets the full price', async () => {
    const c = await resolveExpectedCharge(booking(1000), {
      bookingId: '1', servicePrice: '1000.00', platformFee: '100.00', feeRate: '0.1', feeModel: FEE_MODEL_ON_TOP,
    });
    expect(c).toEqual({ amount: 1100, platformFee: 100, vendorAmount: 1000, feeModel: 'on_top' });
  });
  test('rate changed after the order: the frozen notes still win', async () => {
    mockPrisma.platformSettings.findFirst.mockResolvedValue({ isPlatformFeeEnabled: true, platformFeePercentage: 0.25 });
    const c = await resolveExpectedCharge(booking(1000), { servicePrice: '1000.00', platformFee: '100.00', feeModel: 'on_top' });
    expect(c.amount).toBe(1100);
    expect(c.platformFee).toBe(100);
  });
  test('legacy (no feeModel in notes): booking price, fee deducted at today\'s rate', async () => {
    const c = await resolveExpectedCharge(booking(1000), { bookingId: '1' });
    expect(c).toEqual({ amount: 1000, platformFee: 100, vendorAmount: 900, feeModel: null });
    expect(await resolveExpectedCharge(booking(1000), undefined)).toMatchObject({ amount: 1000 });
  });
  test('on_top notes whose price disagrees with the booking: null (rejected)', async () => {
    expect(await resolveExpectedCharge(booking(1000), { servicePrice: '10.00', platformFee: '1.00', feeModel: 'on_top' })).toBeNull();
    expect(await resolveExpectedCharge(booking(1000), { servicePrice: '1000.00', platformFee: '-5', feeModel: 'on_top' })).toBeNull();
    expect(await resolveExpectedCharge(booking(1000), { servicePrice: '1000.00', platformFee: 'x', feeModel: 'on_top' })).toBeNull();
  });
});
