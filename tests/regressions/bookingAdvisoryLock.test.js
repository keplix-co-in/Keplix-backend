/**
 * Regression test for the CONFIRMED double-booking race, found by the
 * 2026-09-12 codebase audit (code-reviewer/security F39).
 *
 * The clash `findFirst` and the `create` ran inside `prisma.$transaction`,
 * and an existing comment claimed this made them "one atomic unit against
 * the same snapshot". It did not: Postgres's default isolation is READ
 * COMMITTED, not SERIALIZABLE, so two concurrent transactions for the same
 * slot could both see no clash and both insert.
 *
 * The fix: `pg_advisory_xact_lock` inside the transaction, keyed on
 * (vendorId, date, canonical time), serialises concurrent requests for the
 * SAME slot while leaving different slots unaffected.
 *
 * See tests/regressions/bookingStatusGuards.test.js for the file convention.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    vehicle: { findUnique: jest.fn() },
    service: { findUnique: jest.fn() },
    booking: { findFirst: jest.fn(), create: jest.fn() },
    bookingVehicle: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.unstable_mockModule('../../queues/notificationQueue.js', () => ({
  addNotificationJob: jest.fn(),
  default: jest.fn(),
}));

const { createBooking } = await import('../../controllers/user/bookingController.js');
const prisma = (await import('../../util/prisma.js')).default;

describe('booking-slot advisory lock — FIXED, regression guard', () => {
  let tx;

  beforeEach(() => {
    jest.clearAllMocks();
    tx = {
      booking: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      bookingVehicle: { create: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    prisma.$transaction.mockImplementation(async (cb) => cb(tx));
    prisma.service.findUnique.mockResolvedValue({
      id: 7,
      vendorId: 42,
      name: 'Detailing',
      price: 1000,
      segmentPrices: [],
    });
    tx.booking.create.mockResolvedValue({
      id: 101,
      service: { id: 7, vendorId: 42 },
      user: { userProfile: { name: 'Ann' } },
    });
  });

  test('takes an advisory lock BEFORE checking for a clash, not after', async () => {
    const req = {
      user: { id: 1 },
      params: { userId: '1' },
      body: { serviceId: 7, booking_date: '2026-08-25T00:00:00.000Z', booking_time: '2:00 PM', notes: 'x' },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await createBooking(req, res);

    expect(tx.$queryRaw).toHaveBeenCalled();
    const lockCallOrder = tx.$queryRaw.mock.invocationCallOrder[0];
    const clashCallOrder = tx.booking.findFirst.mock.invocationCallOrder[0];
    expect(lockCallOrder).toBeLessThan(clashCallOrder);
  });

  test('the lock key includes vendorId, date, and canonical time, so different slots do not share a lock', async () => {
    const req = {
      user: { id: 1 },
      params: { userId: '1' },
      body: { serviceId: 7, booking_date: '2026-08-25T00:00:00.000Z', booking_time: '2:00 PM', notes: 'x' },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await createBooking(req, res);

    // The tagged-template call's raw strings/values are captured as separate
    // args by Prisma's $queryRaw mock signature: ([strings, ...values]).
    const [, lockKey] = tx.$queryRaw.mock.calls[0];
    expect(lockKey).toContain('42'); // vendorId
    expect(lockKey).toContain('2026-08-25'); // date
    expect(lockKey).toContain('14:00'); // canonical time (from "2:00 PM")
  });
});
