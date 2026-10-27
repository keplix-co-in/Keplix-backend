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
    // updateMany: cancel and reschedule are now guarded writes (the allowed
    // statuses repeated in the WHERE). bookingEarlyStart: a cancel declines
    // any pending early-start offer. vendorProfile: a reschedule is checked
    // against the vendor's opening hours.
    booking: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
    bookingEarlyStart: { updateMany: jest.fn() },
    vendorProfile: { findUnique: jest.fn() },
    service: { findUnique: jest.fn() },
    payment: { update: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(0),
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
  prisma.booking.updateMany.mockResolvedValue({ count: 1 });
  prisma.bookingEarlyStart.updateMany.mockResolvedValue({ count: 0 });
  // Open every day 9-6, so 11:00 is an offered slot for the reschedule tests.
  prisma.vendorProfile.findUnique.mockResolvedValue({
    operating_hours: '9:00 AM - 6:00 PM',
    breaks: '[]',
    holidays: '[]',
  });
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

    // 409, was 400: a state conflict, like every other "booking is no longer
    // in a state that allows this" answer on these endpoints.
    expect(res.status).toHaveBeenCalledWith(409);
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
  });

  /**
   * POLICY DECIDED (owner, 2026-10-20), replacing the "CURRENT POLICY: an
   * in-progress booking may still be cancelled" assertion that stood here as
   * an open question. A customer may cancel only before the job starts:
   * pending, confirmed, scheduled. Once the workshop has started, cancelling
   * stranded a vendor who had done work on a booking that could no longer
   * reach the payout path; a problem with a started job now goes through the
   * dispute path instead.
   */
  test('POLICY: an in-progress booking can no longer be cancelled (409)', async () => {
    prisma.booking.findUnique.mockResolvedValue(
      bookingInProgress({ status: 'in_progress' }),
    );
    const req = mockReq({ status: 'cancelled' });
    const res = mockRes();

    await updateBooking(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
  });

  test('a confirmed booking is cancelled with a guarded write and its pending early-start offer is declined', async () => {
    prisma.booking.findUnique.mockResolvedValue(
      bookingInProgress({ status: 'confirmed' }),
    );
    const req = mockReq({ status: 'cancelled' });
    const res = mockRes();

    await updateBooking(req, res);

    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BOOKING_ID, status: { in: ['pending', 'confirmed', 'scheduled'] } },
        data: expect.objectContaining({ status: 'cancelled' }),
      }),
    );
    expect(prisma.bookingEarlyStart.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookingId: BOOKING_ID, status: 'pending' },
        data: expect.objectContaining({ status: 'declined' }),
      }),
    );
    expect(res.status).not.toHaveBeenCalledWith(409);
  });

  test('a cancel that loses a race with the vendor starting the job is 409, not an overwrite', async () => {
    // Pre-read says confirmed; by write time the vendor has started it.
    prisma.booking.findUnique.mockResolvedValue(
      bookingInProgress({ status: 'confirmed' }),
    );
    prisma.booking.updateMany.mockResolvedValue({ count: 0 });
    const req = mockReq({ status: 'cancelled' });
    const res = mockRes();

    await updateBooking(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(prisma.bookingEarlyStart.updateMany).not.toHaveBeenCalled();
  });
});

describe('D6 — reschedule conflict and past-date guards', () => {
  /**
   * WAS: createBooking guarded double-booking inside a transaction, but
   * updateBooking wrote booking_date/booking_time with no equivalent check, so a
   * reschedule could land on an occupied slot or in the past. The guard now
   * mirrors createBooking's, including the legacy 12-hour time label.
   */
  // These used bookingInProgress() as-is. A reschedule is now only allowed
  // from pending/confirmed/scheduled (an in_progress booking is 409 before
  // any of these checks), so the fixtures are 'confirmed'.
  test('refuses to reschedule into the past', async () => {
    prisma.booking.findUnique.mockResolvedValue(bookingInProgress({ status: 'confirmed' }));
    const req = mockReq({ booking_date: '2020-01-01', booking_time: '09:00' });
    const res = mockRes();

    await updateBooking(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  /**
   * Audit #109: the conflict check above ran as a plain query, then a
   * separate `prisma.booking.update` outside any transaction or lock -- the
   * same check-then-act race createBooking already guards against with
   * pg_advisory_xact_lock. Reschedule now takes the identical lock, inside a
   * $transaction, before checking for a clash.
   */
  test('takes the advisory lock and rejects a reschedule onto an occupied slot', async () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    prisma.booking.findUnique.mockResolvedValue(bookingInProgress({ status: 'confirmed', booking_date: future }));
    prisma.$executeRaw.mockResolvedValue(0);
    prisma.booking.findFirst.mockResolvedValue({ id: 99999 }); // a clashing booking
    prisma.$transaction.mockImplementation((cb) => cb(prisma));

    const req = mockReq({
      booking_date: future.toISOString().slice(0, 10),
      booking_time: '11:00',
    });
    const res = mockRes();

    await updateBooking(req, res);

    expect(prisma.$executeRaw).toHaveBeenCalled(); // the advisory lock was taken
    expect(prisma.booking.findFirst).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
  });

  test('reschedules onto a free slot inside the same locked transaction', async () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    prisma.booking.findUnique.mockResolvedValue(bookingInProgress({ status: 'confirmed', booking_date: future }));
    prisma.$executeRaw.mockResolvedValue(0);
    prisma.booking.findFirst.mockResolvedValue(null); // no clash
    prisma.$transaction.mockImplementation((cb) => cb(prisma));

    const req = mockReq({
      booking_date: future.toISOString().slice(0, 10),
      booking_time: '11:00',
    });
    const res = mockRes();

    await updateBooking(req, res);

    expect(prisma.$executeRaw).toHaveBeenCalled();
    // Guarded write: the reschedule only lands if the booking is still in a
    // reschedulable state at write time.
    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BOOKING_ID, status: { in: ['pending', 'confirmed', 'scheduled'] } },
        data: expect.objectContaining({ booking_time: '11:00' }),
      }),
    );
    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(res.status).not.toHaveBeenCalledWith(500);
  });

  test('an in-progress booking cannot be rescheduled (409)', async () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    prisma.booking.findUnique.mockResolvedValue(bookingInProgress({ booking_date: future }));
    const req = mockReq({
      booking_date: future.toISOString().slice(0, 10),
      booking_time: '11:00',
    });
    const res = mockRes();

    await updateBooking(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});
