/**
 * Subscription gate on booking create (owner decision 2026-11-22): a garage
 * whose subscription is past the 7-day grace is hidden from customers, so it
 * must not be bookable either (e.g. a stale service page or a deep link).
 */
import { jest } from '@jest/globals';

const DAY = 24 * 60 * 60 * 1000;
const sub = { current: null };

jest.unstable_mockModule('../../../util/prisma.js', () => ({
  default: {
    vehicle: { findUnique: jest.fn() },
    service: { findUnique: jest.fn() },
    booking: { findFirst: jest.fn(), create: jest.fn() },
    bookingVehicle: { create: jest.fn() },
    bookingQuote: { create: jest.fn() },
    vendorProfile: { findUnique: jest.fn() },
    vendorSubscription: { findUnique: jest.fn(async () => sub.current), create: jest.fn(async ({ data }) => data) },
    $transaction: jest.fn(),
  },
}));
jest.unstable_mockModule('../../../queues/notificationQueue.js', () => ({ addNotificationJob: jest.fn(), default: jest.fn() }));

const { createBooking } = await import('../../../controllers/user/bookingController.js');
const prisma = (await import('../../../util/prisma.js')).default;

const FUTURE = new Date(Date.now() + 60 * DAY).toISOString();
let req, res, tx;

beforeEach(() => {
  jest.clearAllMocks();
  req = { user: { id: 1 }, params: { userId: '1' }, body: { serviceId: 7, booking_date: FUTURE, booking_time: '2:00 PM', notes: 'x' } };
  res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  tx = {
    booking: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    bookingVehicle: { create: jest.fn() },
    bookingQuote: { create: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
  };
  tx.booking.create.mockImplementation(async ({ data }) => ({ id: 101, ...data, service: { id: 7, vendorId: 42, name: 'D' }, user: { userProfile: { name: 'A' } } }));
  prisma.$transaction.mockImplementation(async (cb) => cb(tx));
  prisma.service.findUnique.mockResolvedValue({ id: 7, vendorId: 42, name: 'D', price: 1000, segmentPrices: [] });
  prisma.vendorProfile.findUnique.mockResolvedValue({ status: 'approved', operating_hours: '9:00 AM - 6:00 PM', breaks: '[]', holidays: '[]' });
});

const subEnding = (offsetMs) => ({ vendorId: 42, plan_code: 'gold', period: 'monthly', starts_at: new Date(), ends_at: new Date(Date.now() + offsetMs) });

test('expired (past ends_at + 7d) -> 403 GARAGE_UNAVAILABLE and no booking written', async () => {
  sub.current = subEnding(-8 * DAY);
  await createBooking(req, res);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'GARAGE_UNAVAILABLE', error: expect.objectContaining({ code: 'GARAGE_UNAVAILABLE' }) }));
  expect(tx.booking.create).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
});

test('grace (still listed) is bookable', async () => {
  sub.current = subEnding(-3 * DAY);
  await createBooking(req, res);
  expect(res.status).not.toHaveBeenCalledWith(403);
  expect(tx.booking.create).toHaveBeenCalled();
});

test('a vendor with no subscription row yet gets the lazy trial and is bookable', async () => {
  sub.current = null;
  await createBooking(req, res);
  expect(prisma.vendorSubscription.create).toHaveBeenCalledWith({ data: expect.objectContaining({ vendorId: 42, plan_code: 'gold', period: 'trial' }) });
  expect(res.status).not.toHaveBeenCalledWith(403);
  expect(tx.booking.create).toHaveBeenCalled();
});
