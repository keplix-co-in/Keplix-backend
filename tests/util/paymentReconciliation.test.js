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

// The booking write inside the transaction is a guarded updateMany (see the
// guard tests at the bottom); it is hoisted so tests can set its count.
const mockTxBookingUpdateMany = jest.fn();

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    booking: { findMany: jest.fn(), update: jest.fn() },
    payment: { upsert: jest.fn() },
    $transaction: jest.fn((cb) =>
      cb({
        payment: { upsert: jest.fn() },
        booking: { updateMany: mockTxBookingUpdateMany },
      }),
    ),
  },
}));
jest.unstable_mockModule('../../util/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn() },
}));

const prisma = (await import('../../util/prisma.js')).default;
const { default: Logger } = await import('../../util/logger.js');
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
  mockTxBookingUpdateMany.mockResolvedValue({ count: 1 });
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

/**
 * Review fix 2026-10-24: the booking write was an unconditional update to
 * confirmed. The booking is read at the top of the run and two Razorpay
 * calls happen before the write, so a booking the customer cancelled (or the
 * pending-timeout cron auto-declined) in that gap was revived to confirmed.
 */
describe('reconcileStalePayments booking write is guarded', () => {
  const staleBooking = {
    id: BOOKING_ID,
    service: { price: '2000.00', segmentPrices: [] },
    bookingVehicle: null,
  };

  // Same guard as recordSuccessfulPayment: vendor_status 'accepted' keeps a
  // legacy order on a never-accepted booking from confirming it (it would then
  // be stuck -- accept/reject and pending-timeout all need status 'pending').
  test('confirms only a vendor-accepted booking that is still pending/confirmed', async () => {
    prisma.booking.findMany.mockResolvedValue([staleBooking]);
    mockFetchPayments.mockResolvedValue({ items: [capturedPayment(200000)] });

    await reconcileStalePayments();

    expect(mockTxBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: BOOKING_ID, status: { in: ['pending', 'confirmed'] }, vendor_status: 'accepted' },
      data: { status: 'confirmed' },
    });
    expect(Logger.warn).not.toHaveBeenCalled();
  });

  test('a booking that left pending meanwhile is not revived; the payment is still recorded and ops is told', async () => {
    prisma.booking.findMany.mockResolvedValue([staleBooking]);
    mockFetchPayments.mockResolvedValue({ items: [capturedPayment(200000)] });
    mockTxBookingUpdateMany.mockResolvedValue({ count: 0 });

    const result = await reconcileStalePayments();

    // Recovered = the payment row was written; the money genuinely moved.
    expect(result.recovered).toBe(1);
    expect(Logger.warn).toHaveBeenCalledWith(expect.stringContaining('[ADMIN NOTICE]'));
    expect(Logger.warn).toHaveBeenCalledWith(expect.stringContaining(String(BOOKING_ID)));
  });
});
