/**
 * Pricing v2 booking snapshot (docs/PRICING_V2_API.md section 2): createBooking
 * writes a BookingQuote + lines in the SAME transaction as BookingVehicle when
 * PlatformSettings.pricingV2From is set and now >= it; otherwise the booking
 * is legacy and no quote is written. Harness follows bookingAdvisoryLock.test.js.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    vehicle: { findUnique: jest.fn() },
    service: { findUnique: jest.fn() },
    booking: { findFirst: jest.fn(), create: jest.fn() },
    bookingVehicle: { create: jest.fn() },
    vendorProfile: { findUnique: jest.fn() },
    platformSettings: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.unstable_mockModule('../../queues/notificationQueue.js', () => ({
  addNotificationJob: jest.fn(),
  default: jest.fn(),
}));

const { createBooking } = await import('../../controllers/user/bookingController.js');
const prisma = (await import('../../util/prisma.js')).default;

const FUTURE_DATE_ISO = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();

const run = async () => {
  const req = {
    user: { id: 1 },
    params: { userId: '1' },
    body: { serviceId: 7, booking_date: FUTURE_DATE_ISO, booking_time: '2:00 PM', notes: 'x' },
  };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  await createBooking(req, res);
  return res;
};

describe('createBooking pricing v2 snapshot', () => {
  let tx;

  beforeEach(() => {
    jest.clearAllMocks();
    tx = {
      booking: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      bookingVehicle: { create: jest.fn() },
      bookingQuote: { create: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    prisma.$transaction.mockImplementation(async (cb) => cb(tx));
    prisma.service.findUnique.mockResolvedValue({
      id: 7,
      vendorId: 42,
      name: 'Brake service',
      price: 7800,
      pricing_type: 'starting',
      inclusions: ['Labour'],
      exclusions: ['Rotors'],
      price_change_note: 'Rotor wear',
      tax_inclusive: true,
      segmentPrices: [],
      priceLines: [
        { id: 1, segment: null, kind: 'labour', name: 'Labour', qty: 1, unit_price: 5000, sort_order: 0 },
        { id: 2, segment: null, kind: 'part', name: 'Pads', qty: 1, unit_price: 2800, sort_order: 1 },
      ],
    });
    prisma.vendorProfile.findUnique.mockResolvedValue({
      status: 'approved',
      operating_hours: '9:00 AM - 6:00 PM',
      breaks: '[]',
      holidays: '[]',
    });
    tx.booking.create.mockResolvedValue({ id: 101, service: { id: 7, vendorId: 42 }, user: { userProfile: { name: 'Ann' } } });
  });

  test('switch on (pricingV2From in the past): quote + lines written in the booking transaction', async () => {
    prisma.platformSettings.findFirst.mockResolvedValue({ pricingV2From: new Date(Date.now() - 60_000) });
    const res = await run();

    expect(res.status).toHaveBeenCalledWith(201);
    expect(tx.bookingVehicle.create).toHaveBeenCalled();
    expect(tx.bookingQuote.create).toHaveBeenCalledTimes(1);
    const { data } = tx.bookingQuote.create.mock.calls[0][0];
    expect(data).toMatchObject({
      bookingId: 101,
      pricing_type: 'starting',
      inclusions: ['Labour'],
      exclusions: ['Rotors'],
      price_change_note: 'Rotor wear',
      tax_inclusive: true,
    });
    expect(data.lines.create).toEqual([
      expect.objectContaining({ kind: 'labour', name: 'Labour', qty: 1, unit_price: 5000, sort_order: 0 }),
      expect.objectContaining({ kind: 'part', name: 'Pads', qty: 1, unit_price: 2800, sort_order: 1 }),
    ]);
    // Written after the vehicle row, inside the same transaction callback.
    expect(tx.bookingQuote.create.mock.invocationCallOrder[0]).toBeGreaterThan(tx.bookingVehicle.create.mock.invocationCallOrder[0]);
  });

  test('switch off (no settings row): legacy booking, no quote', async () => {
    prisma.platformSettings.findFirst.mockResolvedValue(null);
    const res = await run();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(tx.bookingQuote.create).not.toHaveBeenCalled();
  });

  test('switch set to a future instant: still legacy', async () => {
    prisma.platformSettings.findFirst.mockResolvedValue({ pricingV2From: new Date(Date.now() + 86_400_000) });
    await run();
    expect(tx.bookingQuote.create).not.toHaveBeenCalled();
  });

  test('settings read fails: booking still created as legacy (never blocks a booking)', async () => {
    prisma.platformSettings.findFirst.mockRejectedValue(new Error('db blip'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await run();
    spy.mockRestore();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(tx.bookingQuote.create).not.toHaveBeenCalled();
  });
});
