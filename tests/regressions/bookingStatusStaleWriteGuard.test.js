/**
 * Regression test for the CONFIRMED stale-read race in
 * updateBookingStatus, found by the 2026-09-12 codebase audit
 * (code-reviewer F41).
 *
 * `currentBooking` was read once, every transition guard branched on
 * `currentBooking.status`, and the write (`prisma.booking.update`) carried
 * no status precondition -- a classic check-then-act. A customer
 * cancellation committing in the gap between the read and the write was
 * silently overwritten: the booking could end up 'completed' while a
 * refund had already been issued for it, and the escrow-hold logic then
 * puts it on the payout path -- vendor paid AND customer refunded for the
 * same booking.
 *
 * The fix: the guard (`allowedFrom`, computed per target status from the
 * exact same branches that already existed) is repeated in the WHERE of an
 * `updateMany`, making the check and the write one statement. `count === 0`
 * means a concurrent write already moved the booking off an allowed
 * status, and the vendor gets a 400 instead of silently winning a race
 * they can't see.
 *
 * See tests/regressions/bookingStatusGuards.test.js for the file convention.
 */
import { jest } from '@jest/globals';

const mockPrisma = {
  booking: { findFirst: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
  payment: { updateMany: jest.fn() },
};

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../util/payoutHelper.js', () => ({ initiateVendorPayout: jest.fn() }));
jest.unstable_mockModule('../../util/communication.js', () => ({ sendPushNotification: jest.fn() }));
jest.unstable_mockModule('../../util/notificationHelper.js', () => ({ createNotification: jest.fn() }));
jest.unstable_mockModule('../../services/healthSheetService.js', () => ({
  assertHealthSheetPresent: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.unstable_mockModule('../../util/platformSettings.js', () => ({
  resolvePayoutHoldUntil: jest.fn().mockResolvedValue(null),
}));
jest.unstable_mockModule('../../queues/notificationQueue.js', () => ({
  addNotificationJob: jest.fn(),
  default: jest.fn(),
}));
jest.unstable_mockModule('../../services/refundPolicy.js', () => ({
  executeCancellationRefund: jest.fn().mockResolvedValue(null),
  resolveCancellationRefund: jest.fn(),
}));

const { updateBookingStatus } = await import('../../controllers/vendor/bookingController.js');

const VENDOR = 42;
const BOOKING_ID = 100;
const mockRes = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('updateBookingStatus stale-write guard — FIXED, regression guard', () => {
  test('the guard and the write are one statement: allowedFrom is repeated in updateMany WHERE', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue({ id: BOOKING_ID, status: 'confirmed', createdAt: new Date() });
    mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.booking.findUnique.mockResolvedValue({
      id: BOOKING_ID, userId: 1, status: 'completed', service: { id: 7, vendorId: VENDOR },
    });

    const req = { user: { id: VENDOR }, params: { id: String(BOOKING_ID) }, body: { status: 'completed' }, files: {}, app: { get: () => null } };
    await updateBookingStatus(req, mockRes());

    expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: BOOKING_ID,
          service: { vendorId: VENDOR },
          status: { in: ['in_progress', 'confirmed', 'scheduled', 'service_completed'] },
        }),
      })
    );
  });

  test('a concurrent write (e.g. a customer cancellation) that already moved the booking off an allowed status returns 400, not a silent overwrite', async () => {
    // currentBooking read shows 'confirmed' -- looks completable -- but by
    // the time updateMany runs, a concurrent cancellation has already moved
    // the row to 'cancelled', so the WHERE's status:{in:[...]} no longer
    // matches and count is 0.
    mockPrisma.booking.findFirst.mockResolvedValue({ id: BOOKING_ID, status: 'confirmed', createdAt: new Date() });
    mockPrisma.booking.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.booking.findUnique.mockResolvedValue({ status: 'cancelled' });

    const req = { user: { id: VENDOR }, params: { id: String(BOOKING_ID) }, body: { status: 'completed' }, files: {}, app: { get: () => null } };
    const res = mockRes();
    await updateBookingStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    // Never reaches the escrow-hold / payment write for a booking that lost the race.
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
  });

  test('sanity check: a status with no transition guard (cancelled) is not restricted by allowedFrom', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue({ id: BOOKING_ID, status: 'pending', createdAt: new Date() });
    mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.booking.findUnique.mockResolvedValue({ id: BOOKING_ID, status: 'cancelled', service: { id: 7, vendorId: VENDOR } });

    const req = { user: { id: VENDOR }, params: { id: String(BOOKING_ID) }, body: { status: 'cancelled' }, files: {}, app: { get: () => null } };
    const res = mockRes();
    await updateBookingStatus(req, res);

    expect(res.status).not.toHaveBeenCalledWith(400);
    const call = mockPrisma.booking.updateMany.mock.calls[0][0];
    expect(call.where.status).toBeUndefined();
  });
});
