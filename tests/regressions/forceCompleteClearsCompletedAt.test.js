/**
 * Regression (review fix 2026-10-24): admin force-complete must not start the
 * auto-confirm payout clock.
 *
 * forceCompleteBooking promises it "cannot itself move money", and relied on
 * leaving service_completed_at untouched. But a booking the vendor completed
 * and the customer then DISPUTED still carries the vendor's old timestamp --
 * already past the 48h window -- so force-completing it out of 'disputed'
 * made the auto-confirm cron release the payout within minutes, over the
 * customer's dispute. The write now clears service_completed_at explicitly.
 *
 * Mocked Prisma, no database.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    booking: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  },
}));
jest.unstable_mockModule('../../queues/notificationQueue.js', () => ({
  addNotificationJob: jest.fn(),
}));
jest.unstable_mockModule('../../util/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn() },
}));

const prisma = (await import('../../util/prisma.js')).default;
const { forceCompleteBooking } = await import('../../controllers/Admin/bookingController.js');

const BOOKING_ID = 801;

const disputedBooking = (overrides = {}) => ({
  id: BOOKING_ID,
  userId: 11,
  status: 'disputed',
  notes: null,
  // The vendor's original completion, days ago: past the auto-confirm window.
  service_completed_at: new Date('2026-10-01T10:00:00.000Z'),
  ...overrides,
});

const mockReq = (body = {}) => ({ body, params: { id: String(BOOKING_ID) }, user: { id: 1 } });
const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  prisma.booking.updateMany.mockResolvedValue({ count: 1 });
});

describe('forceCompleteBooking', () => {
  test('clears service_completed_at so a disputed booking cannot auto-confirm and pay out', async () => {
    prisma.booking.findUnique
      .mockResolvedValueOnce(disputedBooking())
      .mockResolvedValueOnce(disputedBooking({ status: 'service_completed', service_completed_at: null }));
    const res = mockRes();

    await forceCompleteBooking(mockReq({ reason: 'Vendor showed proof of work' }), res);

    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: { id: BOOKING_ID, status: { notIn: ['cancelled', 'user_confirmed', 'completed'] } },
      data: expect.objectContaining({ status: 'service_completed', service_completed_at: null }),
    });
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      booking: expect.objectContaining({ status: 'service_completed', service_completed_at: null }),
    });
  });

  test.each(['cancelled', 'user_confirmed', 'completed'])(
    'still refuses an already-%s booking without writing',
    async (status) => {
      prisma.booking.findUnique.mockResolvedValueOnce(disputedBooking({ status }));
      const res = mockRes();

      await forceCompleteBooking(mockReq(), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(prisma.booking.updateMany).not.toHaveBeenCalled();
    },
  );

  test('409s when the booking changed status between the read and the guarded write', async () => {
    prisma.booking.findUnique.mockResolvedValueOnce(disputedBooking());
    prisma.booking.updateMany.mockResolvedValue({ count: 0 });
    const res = mockRes();

    await forceCompleteBooking(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });
});
