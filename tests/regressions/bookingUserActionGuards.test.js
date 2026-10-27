/**
 * Regression guards for customer-side booking actions (booking-flow plan,
 * 2026-10-20):
 *
 *  - accepting a vendor's early-start offer after the booking was cancelled
 *    used to flip the cancelled booking straight to in_progress; it is now
 *    re-checked inside the transaction and refused with 409;
 *  - a dispute on a booking the customer (or the auto-confirm cron) already
 *    confirmed is a state conflict, 409;
 *  - createBooking and reschedule accepted any parseable time -- 14:15
 *    between two slots (so neither slot's clash check saw it), a lunch
 *    break, a closed weekday, a vendor with no hours at all. They now only
 *    accept a slot the customer could have picked, else 400 with a code.
 *
 * Mocked Prisma, no database.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    vehicle: { findUnique: jest.fn() },
    service: { findUnique: jest.fn() },
    booking: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn() },
    bookingEarlyStart: { update: jest.fn(), updateMany: jest.fn() },
    vendorProfile: { findUnique: jest.fn() },
    user: { findUnique: jest.fn().mockResolvedValue({ pushToken: null }) },
    $transaction: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(0),
  },
}));
jest.unstable_mockModule('../../queues/notificationQueue.js', () => ({
  addNotificationJob: jest.fn(),
}));
jest.unstable_mockModule('../../util/notificationHelper.js', () => ({
  sendPushNotification: jest.fn(),
  createNotification: jest.fn(),
}));
jest.unstable_mockModule('../../services/refundPolicy.js', () => ({
  executeCancellationRefund: jest.fn(),
  resolveCancellationRefund: jest.fn().mockReturnValue({ refundable: false, amount: 0 }),
}));

const { createBooking, updateBooking, respondToEarlyStart } = await import(
  '../../controllers/user/bookingController.js'
);
const { disputeServiceCompletion } = await import('../../controllers/user/serviceConfirmationController.js');
const { WEEKDAYS } = await import('../../util/slots.js');
const prisma = (await import('../../util/prisma.js')).default;

const CUSTOMER_ID = 711;
const VENDOR_ID = 811;
const BOOKING_ID = 9201;

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

// 30 days out, so the past-date guard never interferes.
const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const futureKey = future.toISOString().slice(0, 10);
const futureWeekday = WEEKDAYS[new Date(`${futureKey}T00:00:00.000Z`).getUTCDay()];

const OPEN_PROFILE = {
  operating_hours: '9:00 AM - 6:00 PM',
  breaks: JSON.stringify(['1:00 PM - 2:00 PM']),
  holidays: '[]',
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore?.();
});

describe('respondToEarlyStart', () => {
  const earlyStartBooking = () => ({
    id: BOOKING_ID,
    userId: CUSTOMER_ID,
    status: 'confirmed', // pre-read: still live when the screen loaded
    vendor_status: 'accepted',
    booking_date: new Date(`${futureKey}T00:00:00.000Z`),
    booking_time: '15:00',
    service: { vendorId: VENDOR_ID, name: 'Full Service' },
    earlyStart: { status: 'pending', requested_time: '11:00' },
  });

  test('accepting after the booking was cancelled is 409 and never writes in_progress', async () => {
    prisma.booking.findUnique.mockResolvedValue(earlyStartBooking());
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      booking: {
        // Inside the transaction the booking is already cancelled.
        findUnique: jest.fn().mockResolvedValue({ status: 'cancelled', vendor_status: 'accepted' }),
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn(),
      },
      bookingEarlyStart: { update: jest.fn() },
    };
    prisma.$transaction.mockImplementation(async (cb) => cb(tx));
    const res = mockRes();

    await respondToEarlyStart(
      { params: { id: String(BOOKING_ID) }, body: { accept: true }, user: { id: CUSTOMER_ID } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
    expect(tx.bookingEarlyStart.update).not.toHaveBeenCalled();
  });

  test('a cancel landing between the re-read and the write (guarded count 0) is also 409', async () => {
    prisma.booking.findUnique.mockResolvedValue(earlyStartBooking());
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      booking: {
        findUnique: jest.fn().mockResolvedValue({ status: 'confirmed', vendor_status: 'accepted' }),
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      bookingEarlyStart: { update: jest.fn() },
    };
    prisma.$transaction.mockImplementation(async (cb) => cb(tx));
    const res = mockRes();

    await respondToEarlyStart(
      { params: { id: String(BOOKING_ID) }, body: { accept: true }, user: { id: CUSTOMER_ID } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(409);
  });
});

describe('disputeServiceCompletion', () => {
  const disputeReq = () => ({
    params: { id: String(BOOKING_ID) },
    body: { reason: 'The brakes still squeal after the service' },
    user: { id: CUSTOMER_ID },
  });

  test('a dispute on a user_confirmed booking is 409 and writes nothing', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      id: BOOKING_ID,
      userId: CUSTOMER_ID,
      status: 'user_confirmed',
      service: { vendorId: VENDOR_ID, name: 'Full Service' },
      payment: { id: 1, status: 'success' },
    });
    const res = mockRes();

    await disputeServiceCompletion(disputeReq(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test('a dispute losing the race to a confirmation (guarded count 0) is 409', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      id: BOOKING_ID,
      userId: CUSTOMER_ID,
      status: 'service_completed',
      service: { vendorId: VENDOR_ID, name: 'Full Service' },
      payment: { id: 1, status: 'success' },
    });
    prisma.booking.updateMany.mockResolvedValue({ count: 0 });
    const res = mockRes();

    await disputeServiceCompletion(disputeReq(), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });
});

// [label, expected code, profile, time]
const SLOT_CASES = [
  ['an off-grid time (14:15)', 'SLOT_NOT_OFFERED', OPEN_PROFILE, '14:15'],
  ['a time after closing (19:00)', 'SLOT_NOT_OFFERED', OPEN_PROFILE, '19:00'],
  ['a time inside the lunch break (13:00)', 'SLOT_NOT_OFFERED', OPEN_PROFILE, '13:00'],
  ['a closed weekday', 'VENDOR_CLOSED', { ...OPEN_PROFILE, holidays: JSON.stringify([futureWeekday]) }, '10:00'],
  ['a vendor with no profile', 'VENDOR_CLOSED', null, '10:00'],
];

describe('createBooking slot validation', () => {
  beforeEach(() => {
    prisma.service.findUnique.mockResolvedValue({
      id: 1,
      vendorId: VENDOR_ID,
      price: 799,
      segmentPrices: [],
    });
  });

  test.each(SLOT_CASES)('%s -> 400 %s', async (_label, code, profile, time) => {
    prisma.vendorProfile.findUnique.mockResolvedValue(profile);
    const res = mockRes();

    await createBooking(
      {
        params: { userId: String(CUSTOMER_ID) },
        body: { serviceId: 1, booking_date: future.toISOString(), booking_time: time },
        user: { id: CUSTOMER_ID },
      },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('an offered slot in the legacy 12-hour form passes the slot check', async () => {
    prisma.vendorProfile.findUnique.mockResolvedValue(OPEN_PROFILE);
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
    const res = mockRes();

    await createBooking(
      {
        params: { userId: String(CUSTOMER_ID) },
        body: { serviceId: 1, booking_date: future.toISOString(), booking_time: '2:30 PM' },
        user: { id: CUSTOMER_ID },
      },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('reschedule slot validation', () => {
  test.each(SLOT_CASES)('%s -> 400 %s', async (_label, code, profile, time) => {
    prisma.booking.findUnique.mockResolvedValue({
      id: BOOKING_ID,
      userId: CUSTOMER_ID,
      serviceId: 1,
      status: 'confirmed',
      vendor_status: 'accepted',
      booking_date: new Date('2026-10-01'),
      booking_time: '10:00',
      notes: '',
      payment: null,
      service: { id: 1, vendorId: VENDOR_ID, name: 'Full Service', price: 5000 },
    });
    prisma.vendorProfile.findUnique.mockResolvedValue(profile);
    const res = mockRes();

    await updateBooking(
      {
        params: { id: String(BOOKING_ID), userId: String(CUSTOMER_ID) },
        body: { booking_date: futureKey, booking_time: time },
        user: { id: CUSTOMER_ID },
        app: { get: () => undefined },
      },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
  });
});
