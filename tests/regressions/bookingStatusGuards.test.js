/**
 * Regression tests for CONFIRMED booking-status defects.
 *
 * Every test here was written after verifying the defect in source, not from a
 * hunch. The defects below have been FIXED, so these are now ordinary regression
 * guards: they assert the correct behaviour and fail if it is ever undone.
 * Anything still carrying `test.failing()` is a defect that is still open --
 * such a test passes while the bug exists and turns red once it is fixed.
 *
 * Controller-level with mocked Prisma, matching the existing suites under
 * tests/controllers/. No database, so these run anywhere.
 *
 * The HTTP-level versions of these live in the endpoint sweep and need a test
 * database; these do not, which is why they exist first.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    booking: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    service: { findUnique: jest.fn() },
    payment: { update: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  },
}));
jest.unstable_mockModule('../../queues/notificationQueue.js', () => ({
  addNotificationJob: jest.fn(),
}));
jest.unstable_mockModule('../../services/refundPolicy.js', () => ({
  executeCancellationRefund: jest.fn(),
  resolveCancellationRefund: jest.fn().mockReturnValue({ refundable: false, amount: 0 }),
}));

const { updateBooking } = await import('../../controllers/user/bookingController.js');
const prisma = (await import('../../util/prisma.js')).default;

const CUSTOMER_ID = 501;
const VENDOR_ID = 601;
const BOOKING_ID = 9001;

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const mockReq = (body) => ({
  params: { id: String(BOOKING_ID), userId: String(CUSTOMER_ID) },
  body,
  user: { id: CUSTOMER_ID },
  app: { get: () => undefined },
});

/** A booking the vendor has accepted and is actively working on. */
const bookingInProgress = (overrides = {}) => ({
  id: BOOKING_ID,
  userId: CUSTOMER_ID,
  serviceId: 1,
  status: 'in_progress',
  vendor_status: 'accepted',
  booking_date: new Date('2026-10-01'),
  booking_time: '10:00',
  notes: '',
  payment: { id: 77, status: 'success', amount: 5000, vendorPayoutStatus: 'pending' },
  service: { id: 1, vendorId: VENDOR_ID, name: 'Full Service', price: 5000 },
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  prisma.booking.update.mockImplementation(async ({ data }) => ({
    ...bookingInProgress(),
    ...data,
    service: { id: 1, vendorId: VENDOR_ID, name: 'Full Service', price: 5000 },
  }));
});

describe('D1 — customer cannot write a vendor-owned status (escrow self-release)', () => {
  /**
   * WAS: validators/user/bookingValidators.js listed the full lifecycle enum for
   * this CUSTOMER endpoint, and the controller guarded only the 'cancelled' case
   * before writing `status` verbatim.
   *
   * "Service completed" is the vendor's assertion that work is done. It is also
   * the exact precondition confirmBookingAndQueuePayout requires
   * (services/bookingConfirmationService.js:61). So a customer can set it on
   * themselves and then call /confirm to release the vendor payout -- with no
   * vendor action, and with no check that the booking was ever paid.
   *
   * FIXED: the customer enum is now z.enum(['cancelled']) and the controller
   * rejects any other status with 403. Verified first that the customer app only
   * ever sends 'cancelled' (CancelBooking.jsx), so nothing legitimate broke.
   */
  test('rejects a customer setting status to service_completed', async () => {
    prisma.booking.findUnique.mockResolvedValue(bookingInProgress());
    const req = mockReq({ status: 'service_completed' });
    const res = mockRes();

    await updateBooking(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test('rejects a customer setting status to completed', async () => {
    prisma.booking.findUnique.mockResolvedValue(bookingInProgress());
    const req = mockReq({ status: 'completed' });
    const res = mockRes();

    await updateBooking(req, res);

    expect(prisma.booking.update).not.toHaveBeenCalled();
  });
});

describe('D7 — cancellation after the money has moved', () => {
  /**
   * WAS: cancellation was blocked only for 'completed' and 'cancelled'.
   * Everything else was allowed, including states where the money had moved.
   *
   * 'user_confirmed' is the important one: at that point the payout has already
   * been queued (bookingConfirmationService.js). Cancelling afterwards produces a
   * cancelled booking whose vendor has been, or is about to be, paid.
   */
  test('refuses to cancel a booking already confirmed by the user', async () => {
    prisma.booking.findUnique.mockResolvedValue(
      bookingInProgress({ status: 'user_confirmed' }),
    );
    const req = mockReq({ status: 'cancelled' });
    const res = mockRes();

    await updateBooking(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  /**
   * OPEN PRODUCT QUESTION, not a defect: cancelling an in-progress booking is
   * still permitted. Blocking it strands a customer who wants to stop a job;
   * allowing it means the vendor has done work on a booking that can no longer
   * reach the payout path (which requires service_completed -> user_confirmed),
   * so they can only be paid by an admin settle.
   *
   * Asserting the current behaviour so a change is a deliberate decision rather
   * than an accident. Decide the policy, then change this test with it.
   */
  test('CURRENT POLICY: an in-progress booking may still be cancelled', async () => {
    prisma.booking.findUnique.mockResolvedValue(
      bookingInProgress({ status: 'in_progress' }),
    );
    const req = mockReq({ status: 'cancelled' });
    const res = mockRes();

    await updateBooking(req, res);

    expect(prisma.booking.update).toHaveBeenCalled();
  });
});

describe('D6 — reschedule conflict and past-date guards', () => {
  /**
   * WAS: createBooking guarded double-booking inside a transaction, but
   * updateBooking wrote booking_date/booking_time with no equivalent check, so a
   * reschedule could land on an occupied slot or in the past. The guard now
   * mirrors createBooking's, including the legacy 12-hour time label.
   */
  test('refuses to reschedule into the past', async () => {
    prisma.booking.findUnique.mockResolvedValue(bookingInProgress());
    const req = mockReq({ booking_date: '2020-01-01', booking_time: '09:00' });
    const res = mockRes();

    await updateBooking(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });
});
