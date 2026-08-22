/**
 * requestEarlyStart (vendor side) — the offer must never move the customer's
 * booking on its own, and must not be offered into an occupied earlier slot.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../../util/prisma.js', () => ({
  default: {
    booking: { findFirst: jest.fn(), update: jest.fn() },
    bookingEarlyStart: { upsert: jest.fn() },
    service: { findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.unstable_mockModule('../../../queues/notificationQueue.js', () => ({
  addNotificationJob: jest.fn(),
  default: jest.fn(),
}));
jest.unstable_mockModule('../../../util/payoutHelper.js', () => ({ initiateVendorPayout: jest.fn() }));
jest.unstable_mockModule('../../../util/communication.js', () => ({ sendPushNotification: jest.fn() }));
jest.unstable_mockModule('../../../util/notificationHelper.js', () => ({ createNotification: jest.fn() }));
jest.unstable_mockModule('../../../services/healthSheetService.js', () => ({
  assertHealthSheetPresent: jest.fn(),
}));
jest.unstable_mockModule('../../../util/platformSettings.js', () => ({
  resolvePayoutHoldUntil: jest.fn(),
}));

const { requestEarlyStart } = await import('../../../controllers/vendor/bookingController.js');
const prisma = (await import('../../../util/prisma.js')).default;

const makeRes = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });

const VENDOR = 42;
const booking = (over = {}) => ({
  id: 100,
  userId: 1,
  status: 'confirmed',
  vendor_status: 'accepted',
  booking_date: new Date('2026-08-25T00:00:00.000Z'),
  booking_time: '14:00',
  service: { id: 7, vendorId: VENDOR, name: 'Detailing' },
  earlyStart: null,
  ...over,
});

describe('requestEarlyStart', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      user: { id: VENDOR },
      params: { vendorId: String(VENDOR), id: '100' },
      body: { booking_time: '11:00' },
    };
    res = makeRes();
  });

  test('404 for a booking that is not this vendor\'s', async () => {
    prisma.booking.findFirst.mockResolvedValue(null);
    await requestEarlyStart(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(prisma.bookingEarlyStart.upsert).not.toHaveBeenCalled();
  });

  test.each(['pending', 'completed', 'cancelled', 'in_progress'])(
    'rejects a booking in an ineligible state (%s)',
    async (status) => {
      prisma.booking.findFirst.mockResolvedValue(booking({ status }));
      await requestEarlyStart(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(prisma.bookingEarlyStart.upsert).not.toHaveBeenCalled();
    }
  );

  test('rejects when the vendor has not accepted the booking yet', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ vendor_status: 'pending' }));
    await requestEarlyStart(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects a requested time that is not earlier than the booked time', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking());
    req.body.booking_time = '14:00';
    await requestEarlyStart(req, res);
    expect(res.status).toHaveBeenCalledWith(400);

    res = makeRes();
    req.body.booking_time = '4:00 PM';
    await requestEarlyStart(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.bookingEarlyStart.upsert).not.toHaveBeenCalled();
  });

  test('rejects an unparseable requested time', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking());
    req.body.booking_time = 'soon';
    await requestEarlyStart(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('409 when the earlier window is already occupied', async () => {
    prisma.booking.findFirst
      .mockResolvedValueOnce(booking())
      .mockResolvedValueOnce({ id: 77 }); // the clash query
    await requestEarlyStart(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(prisma.bookingEarlyStart.upsert).not.toHaveBeenCalled();
  });

  test('the clash query matches both canonical and legacy stored times, excluding self and dead statuses', async () => {
    prisma.booking.findFirst.mockResolvedValueOnce(booking()).mockResolvedValueOnce(null);
    await requestEarlyStart(req, res);

    const where = prisma.booking.findFirst.mock.calls[1][0].where;
    expect(where.id).toEqual({ not: 100 });
    expect(where.service).toEqual({ vendorId: VENDOR });
    expect(where.booking_time.in).toEqual(expect.arrayContaining(['11:00', '11:00 AM']));
    expect(where.NOT).toEqual({ status: { in: ['cancelled', 'rejected'] } });
  });

  test('a successful request does NOT change the booking status or time', async () => {
    prisma.booking.findFirst.mockResolvedValueOnce(booking()).mockResolvedValueOnce(null);
    await requestEarlyStart(req, res);

    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(prisma.bookingEarlyStart.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookingId: 100 },
        create: expect.objectContaining({ requested_time: '11:00', status: 'pending' }),
        update: expect.objectContaining({ requested_time: '11:00', status: 'pending' }),
      })
    );
    expect(res.json.mock.calls[0][0]).toEqual(expect.objectContaining({ success: true }));
  });

  test('re-requesting replaces the previous offer rather than leaving a stale accepted one', async () => {
    prisma.booking.findFirst
      .mockResolvedValueOnce(booking({ earlyStart: { status: 'declined', requested_time: '12:00' } }))
      .mockResolvedValueOnce(null);
    await requestEarlyStart(req, res);

    const upsert = prisma.bookingEarlyStart.upsert.mock.calls[0][0];
    expect(upsert.update).toEqual(
      expect.objectContaining({ status: 'pending', responded_at: null, started_at: null })
    );
  });
});
