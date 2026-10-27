/**
 * Regression tests for two CONFIRMED customer-side booking defects found by
 * the 2026-09-28 bookingcust audit (tests/audit/bookingcust.flow.mjs).
 *
 * Both are now FIXED; these are ordinary regression guards.
 *
 * Controller-level with mocked Prisma, matching the existing suites under
 * tests/regressions/. No database, so these run anywhere.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    vehicle: { findUnique: jest.fn() },
    service: { findUnique: jest.fn() },
    // updateMany: the dispute write is now guarded on status
    // 'service_completed' in its WHERE.
    booking: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn() },
    // createBooking now checks the requested time against the vendor's
    // opening hours before the transaction (see checkSlotBookable).
    vendorProfile: { findUnique: jest.fn() },
    user: { findUnique: jest.fn().mockResolvedValue({ pushToken: null, email: 'vendor@audit.test' }) },
    $transaction: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(0),
  },
}));
jest.unstable_mockModule('../../queues/notificationQueue.js', () => ({
  addNotificationJob: jest.fn(),
}));
jest.unstable_mockModule('../../util/notificationHelper.js', () => ({
  sendPushNotification: jest.fn(),
}));

const { createBooking } = await import('../../controllers/user/bookingController.js');
const { disputeServiceCompletion } = await import('../../controllers/user/serviceConfirmationController.js');
const prisma = (await import('../../util/prisma.js')).default;

const CUSTOMER_ID = 701;
const VENDOR_ID = 801;
const SERVICE_ID = 1;
const BOOKING_ID = 9101;

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('D-past-date — createBooking accepted a booking_date already in the past', () => {
  /**
   * WAS: createBooking had no guard on booking_date at all -- unlike
   * updateBooking's reschedule path, which has always rejected a target in
   * the past. A customer could POST a booking_date days ago and it would be
   * created with status 'pending': invisible to the vendor's day view
   * (getVendorSlots filters past slots only for TODAY, and does nothing for
   * a wholly past date) and impossible to ever fulfil.
   *
   * FIXED: createBooking now runs the identical IST past-date check
   * updateBooking already used, before opening the advisory-lock
   * transaction, so a bad date is rejected before anything is written.
   */
  test('rejects a booking_date + booking_time already in the past', async () => {
    prisma.service.findUnique.mockResolvedValue({
      id: SERVICE_ID,
      vendorId: VENDOR_ID,
      price: 799,
      segmentPrices: [],
    });

    const req = {
      params: { userId: String(CUSTOMER_ID) },
      body: {
        serviceId: SERVICE_ID,
        booking_date: '2020-01-01T00:00:00.000Z',
        booking_time: '10:00',
      },
      user: { id: CUSTOMER_ID },
    };
    const res = mockRes();

    await createBooking(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('still accepts a future booking_date', async () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    // Open every day so 10:00 is an offered slot.
    prisma.vendorProfile.findUnique.mockResolvedValue({
      operating_hours: '9:00 AM - 6:00 PM',
      breaks: '[]',
      holidays: '[]',
    });
    prisma.service.findUnique.mockResolvedValue({
      id: SERVICE_ID,
      vendorId: VENDOR_ID,
      price: 799,
      segmentPrices: [],
    });
    prisma.$transaction.mockImplementation(async (cb) =>
      cb({
        $executeRaw: jest.fn().mockResolvedValue(0),
        booking: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({
            id: BOOKING_ID,
            service: { vendorId: VENDOR_ID, name: 'Oil Change' },
            user: { userProfile: { name: 'Test' } },
          }),
        },
        bookingVehicle: { create: jest.fn().mockResolvedValue({}) },
      }),
    );

    const req = {
      params: { userId: String(CUSTOMER_ID) },
      body: {
        serviceId: SERVICE_ID,
        booking_date: future.toISOString(),
        booking_time: '10:00',
      },
      user: { id: CUSTOMER_ID },
    };
    const res = mockRes();

    await createBooking(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('D-dispute-guard — dispute was reachable with no vendor-completion precondition', () => {
  /**
   * WAS: disputeServiceCompletion checked ownership and "already disputed"
   * only. A booking still 'pending' vendor acceptance -- where no service
   * had ever taken place -- could be marked 'disputed', which also
   * short-circuited cancellation (updateBooking's NON_CANCELLABLE set
   * excludes 'disputed').
   *
   * FIXED: dispute now requires status === 'service_completed', mirroring
   * confirmServiceCompletion's precondition for the opposite answer.
   */
  test('rejects a dispute on a booking still pending vendor acceptance', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      id: BOOKING_ID,
      userId: CUSTOMER_ID,
      status: 'pending',
      service: { vendorId: VENDOR_ID, name: 'Oil Change' },
      payment: null,
    });

    const req = {
      params: { userId: String(CUSTOMER_ID), id: String(BOOKING_ID) },
      body: { reason: 'Vendor never showed up and I want to dispute this booking.' },
      user: { id: CUSTOMER_ID },
    };
    const res = mockRes();

    await disputeServiceCompletion(req, res);

    // 409, was 400: the request is well-formed, the booking is just in the
    // wrong state -- the same status code every other state conflict on the
    // booking endpoints now returns, so the app can branch on it.
    expect(res.status).toHaveBeenCalledWith(409);
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
  });

  test('allows a dispute once the vendor has marked the service completed', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      id: BOOKING_ID,
      userId: CUSTOMER_ID,
      status: 'service_completed',
      service: { vendorId: VENDOR_ID, name: 'Oil Change' },
      payment: { status: 'success' },
    });
    prisma.booking.updateMany.mockResolvedValue({ count: 1 });

    const req = {
      params: { userId: String(CUSTOMER_ID), id: String(BOOKING_ID) },
      body: { reason: 'The brakes were not actually replaced as claimed.' },
      user: { id: CUSTOMER_ID },
    };
    const res = mockRes();

    await disputeServiceCompletion(req, res);

    // Guarded write that also persists the customer's reason and when they
    // raised it (both shown to the admin resolving the dispute).
    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BOOKING_ID, userId: CUSTOMER_ID, status: 'service_completed' },
        data: {
          status: 'disputed',
          dispute_reason: 'The brakes were not actually replaced as claimed.',
          disputed_at: expect.any(Date),
        },
      }),
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});
