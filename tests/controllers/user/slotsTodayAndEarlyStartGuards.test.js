/**
 * getVendorSlots "today" filtering (IST clock frozen) and the
 * respondToEarlyStart guards that stop an offer being applied twice.
 */
import { jest } from '@jest/globals';

// 2026-08-25 is a Tuesday. Freeze the IST clock at 13:10 on that day so the
// past-slot filter is deterministic.
const FROZEN_IST = new Date(2026, 7, 25, 13, 10, 0);

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
jest.unstable_mockModule('../../../util/time.js', () => ({
  getISTDate: jest.fn(() => new Date(FROZEN_IST)),
}));

const { getVendorSlots, respondToEarlyStart } = await import(
  '../../../controllers/user/bookingController.js'
);
const prisma = (await import('../../../util/prisma.js')).default;

const makeRes = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });

const HOURS = { operating_hours: '10:00 AM - 4:00 PM', breaks: null, holidays: null };

describe('getVendorSlots — today vs future', () => {
  let res;

  beforeEach(() => {
    jest.clearAllMocks();
    res = makeRes();
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.vendorProfile.findUnique.mockResolvedValue(HOURS);
  });

  const call = async (date) => {
    await getVendorSlots({ params: { vendorId: '42' }, query: { date }, user: { id: 1 } }, res);
    return res.json.mock.calls[0][0].data;
  };

  test('for TODAY, slots already past (in IST) are excluded', async () => {
    const data = await call('2026-08-25');
    // now = 13:10, so 13:00 and everything before it is gone; 13:30 is the first
    expect(data.closed).toBe(false);
    expect(data.slots.map((s) => s.time)).toEqual(['13:30', '14:00', '14:30', '15:00', '15:30']);
  });

  test('for a FUTURE date, the whole day is offered', async () => {
    const data = await call('2026-08-26');
    expect(data.slots.map((s) => s.time)).toEqual([
      '10:00', '10:30', '11:00', '11:30', '12:00', '12:30',
      '13:00', '13:30', '14:00', '14:30', '15:00', '15:30',
    ]);
  });

  test('a past date is NOT filtered — documents that only "today" is time-filtered', async () => {
    const data = await call('2026-08-24');
    // Not "today", so no filtering — the endpoint does not reject past dates.
    // Documenting actual behaviour: the full day is still offered.
    expect(data.slots.length).toBeGreaterThan(0);
  });

  test('taken slots come back available:false rather than being omitted', async () => {
    prisma.booking.findMany.mockResolvedValue([
      { booking_time: '11:00' },
      { booking_time: '2:00 PM' }, // legacy row
    ]);
    const data = await call('2026-08-26');
    const byTime = Object.fromEntries(data.slots.map((s) => [s.time, s.available]));
    expect(Object.keys(byTime)).toContain('11:00');
    expect(byTime['11:00']).toBe(false);
    expect(byTime['14:00']).toBe(false);
    expect(byTime['10:00']).toBe(true);
  });

  test('a holiday weekday is closed with an empty slot list and no booking query', async () => {
    prisma.vendorProfile.findUnique.mockResolvedValue({ ...HOURS, holidays: '["tuesday"]' });
    const data = await call('2026-08-25');
    expect(data).toEqual({ date: '2026-08-25', closed: true, slots: [] });
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
  });

  test('an unknown vendor is a 404', async () => {
    prisma.vendorProfile.findUnique.mockResolvedValue(null);
    await getVendorSlots({ params: { vendorId: '999' }, query: { date: '2026-08-26' }, user: { id: 1 } }, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('junk vendor hours never 500 — they render as closed', async () => {
    for (const bad of ['', '   ', 'open all hours', null, '8:00 PM - 10:00 AM']) {
      jest.clearAllMocks();
      res = makeRes();
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.vendorProfile.findUnique.mockResolvedValue({
        operating_hours: bad,
        breaks: '[[[',
        holidays: '{"a":1}',
      });
      const data = await call('2026-08-26');
      expect(data).toEqual({ date: '2026-08-26', closed: true, slots: [] });
      expect(res.status).not.toHaveBeenCalledWith(500);
    }
  });
});

describe('respondToEarlyStart — apply-once guards', () => {
  let req, res, txBooking, txEarly;

  const pending = (over = {}) => ({
    id: 100,
    userId: 1,
    status: 'confirmed',
    booking_time: '14:00',
    service: { id: 7, vendorId: 42, name: 'Detailing' },
    earlyStart: { status: 'pending', requested_time: '11:00' },
    ...over,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    req = { params: { userId: '1', id: '100' }, body: { accept: true }, user: { id: 1 } };
    res = makeRes();
    txEarly = { update: jest.fn() };
    txBooking = {
      update: jest.fn().mockResolvedValue({ id: 100, status: 'in_progress', booking_time: '11:00' }),
    };
    prisma.$transaction.mockImplementation(async (cb) =>
      cb({ bookingEarlyStart: txEarly, booking: txBooking })
    );
  });

  test('accept sets in_progress, stamps started_at and moves booking_time', async () => {
    prisma.booking.findUnique.mockResolvedValue(pending());
    await respondToEarlyStart(req, res);

    expect(txBooking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 100 },
        data: expect.objectContaining({ status: 'in_progress', booking_time: '11:00' }),
      })
    );
    const earlyData = txEarly.update.mock.calls[0][0].data;
    expect(earlyData.status).toBe('accepted');
    expect(earlyData.started_at).toBeInstanceOf(Date);
    expect(res.json.mock.calls[0][0].booking.status).toBe('in_progress');
  });

  test('a SECOND accept of the same request cannot double-apply', async () => {
    prisma.booking.findUnique.mockResolvedValue(
      pending({ status: 'in_progress', earlyStart: { status: 'accepted', requested_time: '11:00' } })
    );
    await respondToEarlyStart(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(txBooking.update).not.toHaveBeenCalled();
  });

  test('accepting an already-declined request is refused', async () => {
    prisma.booking.findUnique.mockResolvedValue(
      pending({ earlyStart: { status: 'declined', requested_time: '11:00' } })
    );
    await respondToEarlyStart(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('decline leaves status and booking_time untouched', async () => {
    prisma.booking.findUnique.mockResolvedValue(pending());
    req.body.accept = false;
    await respondToEarlyStart(req, res);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
    const returned = res.json.mock.calls[0][0].booking;
    expect(returned.status).toBe('confirmed');
    expect(returned.booking_time).toBe('14:00');
  });

  test('a missing accept flag is treated as a decline, never an accept', async () => {
    prisma.booking.findUnique.mockResolvedValue(pending());
    req.body = {};
    await respondToEarlyStart(req, res);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.bookingEarlyStart.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'declined' }) })
    );
  });

  test('404 for an unknown booking, 403 for someone else\'s', async () => {
    prisma.booking.findUnique.mockResolvedValue(null);
    await respondToEarlyStart(req, res);
    expect(res.status).toHaveBeenCalledWith(404);

    res = makeRes();
    prisma.booking.findUnique.mockResolvedValue(pending({ userId: 2 }));
    await respondToEarlyStart(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
