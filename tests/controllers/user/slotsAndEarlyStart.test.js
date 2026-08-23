import { jest } from '@jest/globals';

jest.unstable_mockModule('../../../util/prisma.js', () => ({
  default: {
    vendorProfile: { findUnique: jest.fn() },
    booking: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    bookingEarlyStart: { update: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.unstable_mockModule('../../../queues/notificationQueue.js', () => ({
  addNotificationJob: jest.fn(),
  default: jest.fn(),
}));

const { getVendorSlots, respondToEarlyStart } = await import(
  '../../../controllers/user/bookingController.js'
);
const prisma = (await import('../../../util/prisma.js')).default;
const { addNotificationJob } = await import('../../../queues/notificationQueue.js');

const makeRes = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });

describe('getVendorSlots', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    // 2026-08-25 is a Tuesday; a far-future date so the "past slots on today"
    // filter never interferes with these assertions.
    req = { params: { vendorId: '42' }, query: { date: '2026-08-25' }, user: { id: 1 } };
    res = makeRes();
    prisma.booking.findMany.mockResolvedValue([]);
  });

  test('400 when the date is missing or malformed', async () => {
    req.query.date = '25/08/2026';
    await getVendorSlots(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('404 when the vendor has no profile', async () => {
    prisma.vendorProfile.findUnique.mockResolvedValue(null);
    await getVendorSlots(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('closed with no slots when the weekday is a holiday', async () => {
    prisma.vendorProfile.findUnique.mockResolvedValue({
      operating_hours: '10:00 AM - 8:00 PM',
      breaks: JSON.stringify(['1:00 PM - 2:00 PM']),
      holidays: JSON.stringify(['Tuesday']),
    });

    await getVendorSlots(req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { date: '2026-08-25', closed: true, slots: [] },
    });
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
  });

  test('closed when the hours string is unparseable', async () => {
    prisma.vendorProfile.findUnique.mockResolvedValue({
      operating_hours: 'open all hours',
      breaks: null,
      holidays: null,
    });

    await getVendorSlots(req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { date: '2026-08-25', closed: true, slots: [] },
    });
  });

  test('marks taken slots unavailable, matching legacy and canonical times alike', async () => {
    prisma.vendorProfile.findUnique.mockResolvedValue({
      operating_hours: '10:00 AM - 12:00 PM',
      breaks: JSON.stringify(['10:30 AM - 11:00 AM']),
      holidays: JSON.stringify(['Sunday']),
    });
    prisma.booking.findMany.mockResolvedValue([
      { booking_time: '11:00' },       // canonical row
      { booking_time: '11:30 AM' },    // legacy row
    ]);

    await getVendorSlots(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.closed).toBe(false);
    expect(payload.data.slots).toEqual([
      { time: '10:00', label: '10:00 AM', available: true },
      { time: '11:00', label: '11:00 AM', available: false },
      { time: '11:30', label: '11:30 AM', available: false },
    ]);

    // Scoped through service.vendorId — Booking has no vendorId of its own —
    // and cancelled/rejected bookings must not hold a slot.
    const where = prisma.booking.findMany.mock.calls[0][0].where;
    expect(where.service).toEqual({ vendorId: 42 });
    expect(where.NOT).toEqual({ status: { in: ['cancelled', 'rejected'] } });
  });
});

describe('respondToEarlyStart', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      params: { userId: '1', id: '100' },
      body: { accept: true },
      user: { id: 1 },
    };
    res = makeRes();
    prisma.$transaction.mockImplementation(async (cb) =>
      cb({
        bookingEarlyStart: { update: jest.fn() },
        booking: { update: jest.fn().mockResolvedValue({ id: 100, status: 'in_progress', booking_time: '11:00' }) },
      })
    );
  });

  const pendingBooking = {
    id: 100,
    userId: 1,
    status: 'confirmed',
    booking_time: '14:00',
    service: { id: 7, vendorId: 42, name: 'Detailing' },
    earlyStart: { status: 'pending', requested_time: '11:00' },
  };

  test('403 when the booking belongs to someone else', async () => {
    prisma.booking.findUnique.mockResolvedValue({ ...pendingBooking, userId: 2 });
    await respondToEarlyStart(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('400 when there is no pending request', async () => {
    prisma.booking.findUnique.mockResolvedValue({ ...pendingBooking, earlyStart: null });
    await respondToEarlyStart(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('accepting moves the booking to in_progress and frees the original slot', async () => {
    prisma.booking.findUnique.mockResolvedValue(pendingBooking);

    await respondToEarlyStart(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.booking.status).toBe('in_progress');
    // booking_time moved to the earlier slot: slot occupancy is derived from
    // it, so the original 14:00 window is bookable again.
    expect(payload.booking.booking_time).toBe('11:00');
    expect(addNotificationJob).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'EARLY_START_ACCEPTED', recipientId: 42 })
    );
  });

  test('declining leaves the booking untouched', async () => {
    prisma.booking.findUnique.mockResolvedValue(pendingBooking);
    req.body.accept = false;

    await respondToEarlyStart(req, res);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.bookingEarlyStart.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'declined' }) })
    );
    expect(res.json.mock.calls[0][0].booking.status).toBe('confirmed');
  });
});
