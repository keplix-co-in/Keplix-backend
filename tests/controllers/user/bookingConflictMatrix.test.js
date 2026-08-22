/**
 * createBooking double-booking guard, exercised against a tiny in-memory
 * stand-in for the Booking table rather than a hand-stubbed findFirst, so the
 * assertions test the WHERE the controller actually builds — vendor scoping,
 * date scoping, status exclusion and (critically) time normalisation of
 * legacy "2:00 PM" rows.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../../util/prisma.js', () => ({
  default: {
    vehicle: { findUnique: jest.fn() },
    service: { findUnique: jest.fn() },
    booking: { findFirst: jest.fn(), create: jest.fn() },
    bookingVehicle: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.unstable_mockModule('../../../queues/notificationQueue.js', () => ({
  addNotificationJob: jest.fn(),
  default: jest.fn(),
}));

const { createBooking } = await import('../../../controllers/user/bookingController.js');
const prisma = (await import('../../../util/prisma.js')).default;

// Minimal evaluator for the exact WHERE shape this controller builds.
const matches = (row, where) => {
  if (where.service?.vendorId !== undefined && row.vendorId !== where.service.vendorId) return false;
  if (where.booking_date && row.booking_date.getTime() !== new Date(where.booking_date).getTime()) {
    return false;
  }
  if (where.booking_time?.in && !where.booking_time.in.includes(row.booking_time)) return false;
  if (where.booking_time && !where.booking_time.in && where.booking_time !== row.booking_time) {
    return false;
  }
  if (where.NOT?.status?.in && where.NOT.status.in.includes(row.status)) return false;
  return true;
};

const VENDOR = 42;

describe('createBooking conflict matrix (fake booking table)', () => {
  let req, res, tx, table;

  const run = async (body = {}) => {
    req.body = { ...req.body, ...body };
    await createBooking(req, res);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    table = [];

    req = {
      user: { id: 1 },
      params: { userId: '1' },
      body: {
        serviceId: 7,
        booking_date: '2026-08-25T00:00:00.000Z',
        booking_time: '14:00',
        notes: 'x',
      },
    };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    tx = {
      booking: {
        findFirst: jest.fn(async ({ where }) => table.find((r) => matches(r, where)) ?? null),
        create: jest.fn(async ({ data }) => ({
          id: 101,
          ...data,
          service: { id: 7, vendorId: VENDOR, name: 'Detailing' },
          user: { userProfile: { name: 'Ann' } },
        })),
      },
      bookingVehicle: { create: jest.fn() },
    };

    prisma.$transaction.mockImplementation(async (cb) => cb(tx));
    prisma.service.findUnique.mockResolvedValue({
      id: 7,
      vendorId: VENDOR,
      name: 'Detailing',
      price: 1000,
      segmentPrices: [],
    });
  });

  const existing = (over = {}) => ({
    id: 55,
    vendorId: VENDOR,
    booking_date: new Date('2026-08-25T00:00:00.000Z'),
    booking_time: '14:00',
    status: 'confirmed',
    ...over,
  });

  test('the guard runs on the tx client, never on the outer prisma (a check outside the transaction is a race)', async () => {
    await run();
    expect(tx.booking.findFirst).toHaveBeenCalled();
    expect(prisma.booking.findFirst).not.toHaveBeenCalled();
    // and it must be read BEFORE the insert
    expect(tx.booking.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      tx.booking.create.mock.invocationCallOrder[0]
    );
  });

  test('an identical canonical booking collides -> 409, nothing written', async () => {
    table.push(existing());
    await run();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(tx.booking.create).not.toHaveBeenCalled();
  });

  test('a cancelled booking does NOT hold the slot', async () => {
    table.push(existing({ status: 'cancelled' }));
    await run();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('a rejected booking does NOT hold the slot', async () => {
    table.push(existing({ status: 'rejected' }));
    await run();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('a pending booking DOES hold the slot', async () => {
    table.push(existing({ status: 'pending' }));
    await run();
    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('a different vendor at the same date/time does NOT collide', async () => {
    table.push(existing({ vendorId: 999 }));
    await run();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('a different date at the same time does NOT collide', async () => {
    table.push(existing({ booking_date: new Date('2026-08-26T00:00:00.000Z') }));
    await run();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('a different time on the same date does NOT collide', async () => {
    table.push(existing({ booking_time: '15:00' }));
    await run();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  // === The legacy-row case ===
  test('a legacy row stored as "2:00 PM" collides with a new "14:00" request', async () => {
    table.push(existing({ booking_time: '2:00 PM' }));
    await run({ booking_time: '14:00' });
    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('a canonical "14:00" row collides with a legacy "2:00 PM" request', async () => {
    table.push(existing({ booking_time: '14:00' }));
    await run({ booking_time: '2:00 PM' });
    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('unparseable booking_time is rejected before any write', async () => {
    await run({ booking_time: 'afternoon' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
