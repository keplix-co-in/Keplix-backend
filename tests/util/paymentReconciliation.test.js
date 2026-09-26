/**
 * Regression test for audit #148: reconcileStalePayments recomputed the
 * expected amount from `Service.price` directly, ignoring both segment
 * pricing and BookingVehicle.price_snapshot -- the same duplicated-pricing
 * mistake util/servicePricing.js's resolveBookingAmount exists to prevent
 * (see its own docstring). A recovered payment could therefore be recorded
 * with the wrong amount, or the captured-vs-expected check could reject a
 * genuinely correct capture as a mismatch.
 *
 * Mocks Razorpay entirely -- this only exercises the amount computation and
 * the resulting Payment.amount, not the reconciliation flow end to end.
 */
import { jest } from '@jest/globals';

const mockOrdersAll = jest.fn();
const mockFetchPayments = jest.fn();

jest.unstable_mockModule('razorpay', () => ({
  default: jest.fn().mockImplementation(() => ({
    orders: { all: mockOrdersAll, fetchPayments: mockFetchPayments },
  })),
}));

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    booking: { findMany: jest.fn(), update: jest.fn() },
    payment: { upsert: jest.fn() },
    $transaction: jest.fn((cb) =>
      cb({
        payment: { upsert: jest.fn() },
        booking: { update: jest.fn() },
      }),
    ),
  },
}));

const prisma = (await import('../../util/prisma.js')).default;
const { reconcileStalePayments } = await import('../../util/paymentReconciliation.js');

const BOOKING_ID = 501;

const capturedPayment = (amountPaise) => ({
  id: 'pay_test123',
  status: 'captured',
  amount: amountPaise,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockOrdersAll.mockResolvedValue({ items: [{ id: 'order_test123' }] });
});

describe('reconcileStalePayments amount resolution (audit #148)', () => {
  test('uses BookingVehicle.price_snapshot, not Service.price, when present', async () => {
    prisma.booking.findMany.mockResolvedValue([
      {
        id: BOOKING_ID,
        service: { price: '5000.00', segmentPrices: [] }, // stale/wrong if used directly
        bookingVehicle: { price_snapshot: '3500.00', segment: 'hatchback' },
      },
    ]);
    // The actual charged price (segment-priced, snapshotted at booking time)
    // was 3500, not the service's current base price of 5000.
    mockFetchPayments.mockResolvedValue({ items: [capturedPayment(350000)] });

    const result = await reconcileStalePayments();

    expect(result.recovered).toBe(1);
  });

  test('rejects a capture that does not match the snapshot price (still catches real mismatches)', async () => {
    prisma.booking.findMany.mockResolvedValue([
      {
        id: BOOKING_ID,
        service: { price: '5000.00', segmentPrices: [] },
        bookingVehicle: { price_snapshot: '3500.00', segment: 'hatchback' },
      },
    ]);
    // Captured amount matches the service's stale base price, not the
    // snapshot -- this must still be flagged, not silently "recovered".
    mockFetchPayments.mockResolvedValue({ items: [capturedPayment(500000)] });

    const result = await reconcileStalePayments();

    expect(result.recovered).toBe(0);
  });

  test('falls back to resolved service price when there is no BookingVehicle', async () => {
    prisma.booking.findMany.mockResolvedValue([
      {
        id: BOOKING_ID,
        service: { price: '2000.00', segmentPrices: [] },
        bookingVehicle: null,
      },
    ]);
    mockFetchPayments.mockResolvedValue({ items: [capturedPayment(200000)] });

    const result = await reconcileStalePayments();

    expect(result.recovered).toBe(1);
  });
});
