/**
 * FIX A: status / vendor_status must be validated against an allow-list
 * before being written to Booking.status / Booking.vendor_status. Covers
 * the three write sites: vendor respondToServiceRequest, vendor
 * updateBookingStatus, and user updateBooking.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    booking: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    payment: { updateMany: jest.fn() },
  },
}));
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

const { respondToServiceRequest, updateBookingStatus } = await import('../../controllers/vendor/bookingController.js');
const { updateBooking } = await import('../../controllers/user/bookingController.js');
const prisma = (await import('../../util/prisma.js')).default;

const makeRes = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });

const VENDOR = 42;
const USER = 1;

describe('Booking status allow-list', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('respondToServiceRequest (vendor_status)', () => {
    test('rejects a bogus vendor_status with 400 before touching the DB', async () => {
      const req = { user: { id: VENDOR }, params: { id: '100' }, body: { vendor_status: 'hacked' } };
      const res = makeRes();
      await respondToServiceRequest(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(prisma.booking.findFirst).not.toHaveBeenCalled();
      expect(prisma.booking.update).not.toHaveBeenCalled();
    });

    test('accepts a valid vendor_status ("accepted")', async () => {
      prisma.booking.findFirst.mockResolvedValue({
        id: 100,
        userId: USER,
        vendor_status: 'pending',
        service: { id: 7, vendorId: VENDOR, name: 'Detailing' },
        user: { userProfile: {} },
      });
      // The guard-and-write is now one updateMany (see F40 fix), not a
      // separate check-then-update -- count: 1 means the WHERE (including
      // vendor_status/status:'pending') matched, i.e. no concurrent write
      // (e.g. the auto-decline cron) beat this one to it.
      prisma.booking.updateMany.mockResolvedValue({ count: 1 });
      prisma.booking.findUnique.mockResolvedValue({
        id: 100,
        userId: USER,
        vendor_status: 'accepted',
        status: 'confirmed',
        service: { id: 7, name: 'Detailing' },
        user: { userProfile: {} },
      });
      const req = {
        user: { id: VENDOR },
        params: { id: '100' },
        body: { vendor_status: 'accepted' },
        app: { get: () => null },
      };
      const res = makeRes();
      await respondToServiceRequest(req, res);
      expect(res.status).not.toHaveBeenCalledWith(400);
      expect(prisma.booking.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 100, vendor_status: 'pending', status: 'pending' }),
          data: expect.objectContaining({ vendor_status: 'accepted' }),
        })
      );
    });

    test('returns 400 (not a silent overwrite) when a concurrent write already moved the booking off pending', async () => {
      prisma.booking.findFirst.mockResolvedValue({
        id: 100,
        userId: USER,
        vendor_status: 'pending',
        service: { id: 7, vendorId: VENDOR, name: 'Detailing' },
        user: { userProfile: {} },
      });
      // Simulates the auto-decline cron winning the race between the
      // findFirst above and this updateMany: it already flipped the row to
      // rejected/cancelled, so the WHERE's vendor_status:'pending' no longer
      // matches and count is 0.
      prisma.booking.updateMany.mockResolvedValue({ count: 0 });
      prisma.booking.findUnique.mockResolvedValue({ vendor_status: 'rejected' });

      const req = {
        user: { id: VENDOR },
        params: { id: '100' },
        body: { vendor_status: 'accepted' },
        app: { get: () => null },
      };
      const res = makeRes();
      await respondToServiceRequest(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'Request already rejected' });
    });
  });

  describe('updateBookingStatus (vendor, status)', () => {
    test('rejects a bogus status with 400 before touching the DB', async () => {
      const req = { user: { id: VENDOR }, params: { id: '100' }, body: { status: 'hacked' }, files: {} };
      const res = makeRes();
      await updateBookingStatus(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(prisma.booking.findFirst).not.toHaveBeenCalled();
      expect(prisma.booking.update).not.toHaveBeenCalled();
    });

    test('accepts a valid status ("cancelled") and proceeds', async () => {
      prisma.booking.findFirst.mockResolvedValue({
        id: 100,
        status: 'confirmed',
        createdAt: new Date(),
      });
      // 'cancelled' has no transition guard in updateBookingStatus, so
      // allowedFrom stays null and the updateMany's WHERE carries no status
      // restriction -- it should succeed regardless of current status.
      prisma.booking.updateMany.mockResolvedValue({ count: 1 });
      prisma.booking.findUnique.mockResolvedValue({
        id: 100,
        userId: USER,
        status: 'cancelled',
        service: { id: 7, name: 'Detailing' },
      });
      const req = {
        user: { id: VENDOR },
        params: { id: '100' },
        body: { status: 'cancelled' },
        files: {},
        app: { get: () => null },
      };
      const res = makeRes();
      await updateBookingStatus(req, res);
      expect(res.status).not.toHaveBeenCalledWith(400);
      expect(prisma.booking.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'cancelled' }) })
      );
    });
  });

  describe('updateBooking (user, status)', () => {
    test('rejects a bogus status with 400 before touching the DB', async () => {
      const req = { user: { id: USER }, params: { id: '100' }, body: { status: 'hacked' } };
      const res = makeRes();
      await updateBooking(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(prisma.booking.findUnique).not.toHaveBeenCalled();
      expect(prisma.booking.update).not.toHaveBeenCalled();
    });

    test('accepts a valid status ("cancelled") and proceeds', async () => {
      prisma.booking.findUnique.mockResolvedValue({
        id: 100,
        userId: USER,
        status: 'confirmed',
        payment: null,
      });
      prisma.booking.update.mockResolvedValue({
        id: 100,
        userId: USER,
        status: 'cancelled',
        service: { id: 7, name: 'Detailing' },
      });
      const req = {
        user: { id: USER },
        params: { id: '100' },
        body: { status: 'cancelled' },
      };
      const res = makeRes();
      await updateBooking(req, res);
      expect(res.status).not.toHaveBeenCalledWith(400);
      expect(prisma.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'cancelled' }) })
      );
    });
  });
});
