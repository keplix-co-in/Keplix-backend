/**
 * Regression: the vendor's status changes go through an explicit transition
 * table (VENDOR_STATUS_TRANSITIONS in controllers/vendor/bookingController.js).
 *
 * Before it, updateBookingStatus was a per-status if-chain; any status without
 * a branch had no precondition, so a vendor could roll a booking back
 * (service_completed -> in_progress / pending), cancel a paid booking without
 * a refund running, or jump straight to user_confirmed. Shipped partner-app
 * versions also sent 'completed', which skipped the customer's
 * confirm-or-dispute step entirely; it is now stored as service_completed with
 * the service_completed_at timestamp that starts the auto-confirm window.
 *
 * Mocked Prisma, no database.
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

const { updateBookingStatus, respondToServiceRequest } = await import(
  '../../controllers/vendor/bookingController.js'
);

const VENDOR = 42;
const BOOKING_ID = 100;
const mockRes = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });
const statusReq = (status, id = String(BOOKING_ID)) => ({
  user: { id: VENDOR },
  params: { id },
  body: { status },
  files: {},
  app: { get: () => null },
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore?.();
});

describe('vendor completion', () => {
  test.each(['completed', 'service_completed'])(
    "'%s' from in_progress is stored as service_completed with service_completed_at",
    async (sent) => {
      mockPrisma.booking.findFirst.mockResolvedValue({ id: BOOKING_ID, status: 'in_progress', createdAt: new Date() });
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: BOOKING_ID, userId: 1, status: 'service_completed', service: { id: 7, vendorId: VENDOR, name: 'Wash' },
      });
      const res = mockRes();

      await updateBookingStatus(statusReq(sent), res);

      const { data } = mockPrisma.booking.updateMany.mock.calls[0][0];
      expect(data.status).toBe('service_completed');
      expect(data.status).not.toBe('completed');
      expect(data.service_completed_at).toBeInstanceOf(Date);
      expect(res.status).not.toHaveBeenCalled();
    },
  );
});

describe('the vendor cannot roll a booking back or cancel it', () => {
  test('in_progress on a service_completed booking -> 400, nothing written', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue({ id: BOOKING_ID, status: 'service_completed', createdAt: new Date() });
    const res = mockRes();

    await updateBookingStatus(statusReq('in_progress'), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
  });

  test('re-marking a service_completed booking as completed -> 400 (would restart the auto-confirm clock)', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue({ id: BOOKING_ID, status: 'service_completed', createdAt: new Date() });
    const res = mockRes();

    await updateBookingStatus(statusReq('service_completed'), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
  });

  test.each(['cancelled', 'pending', 'confirmed', 'user_confirmed', 'disputed'])(
    "'%s' is not a vendor transition -> 400 before any database read",
    async (target) => {
      const res = mockRes();

      await updateBookingStatus(statusReq(target), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockPrisma.booking.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
    },
  );
});

describe('respondToServiceRequest', () => {
  const respondReq = (body, id = String(BOOKING_ID)) => ({
    user: { id: VENDOR },
    params: { id },
    body,
    app: { get: () => null },
  });

  test('a rejection stores the vendor reason in vendor_reject_reason', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue({
      id: BOOKING_ID, userId: 1, status: 'pending', vendor_status: 'pending', service: { name: 'Wash' },
    });
    mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.booking.findUnique.mockResolvedValue({ id: BOOKING_ID, status: 'cancelled', vendor_status: 'rejected' });

    await respondToServiceRequest(respondReq({ vendor_status: 'rejected', reason: 'Fully booked that day' }), mockRes());

    expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          vendor_status: 'rejected',
          status: 'cancelled',
          vendor_reject_reason: 'Fully booked that day',
        }),
      }),
    );
  });

  test('an acceptance does not write a reject reason', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue({
      id: BOOKING_ID, userId: 1, status: 'pending', vendor_status: 'pending', service: { name: 'Wash' },
    });
    mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.booking.findUnique.mockResolvedValue({ id: BOOKING_ID, status: 'confirmed', vendor_status: 'accepted' });

    await respondToServiceRequest(respondReq({ vendor_status: 'accepted', reason: 'ignored' }), mockRes());

    const { data } = mockPrisma.booking.updateMany.mock.calls[0][0];
    expect(data).not.toHaveProperty('vendor_reject_reason');
  });
});
