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

// Computed relative to "now" rather than hardcoded, so this suite does not
// silently start failing once the wall clock passes a fixed date -- it did,
// against 2026-08-25, once createBooking gained a past-date guard (audit:
// bookingcust flow, 2026-09-28).
const FUTURE_DATE_ISO = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
const FUTURE_DATE_KEY = FUTURE_DATE_ISO.slice(0, 10);

describe('booking-slot advisory lock — FIXED, regression guard', () => {
  let tx;

  beforeEach(() => {
    jest.clearAllMocks();
    tx = {
      booking: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      bookingVehicle: { create: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
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
      body: { serviceId: 7, booking_date: FUTURE_DATE_ISO, booking_time: '2:00 PM', notes: 'x' },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await createBooking(req, res);

    expect(tx.$executeRaw).toHaveBeenCalled();
    // The lock must never go through $queryRaw: pg_advisory_xact_lock returns void,
    // which $queryRaw cannot deserialize (P2010) — that made every booking 500.
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    const lockCallOrder = tx.$executeRaw.mock.invocationCallOrder[0];
    const clashCallOrder = tx.booking.findFirst.mock.invocationCallOrder[0];
    expect(lockCallOrder).toBeLessThan(clashCallOrder);
  });

  test('the lock key includes vendorId, date, and canonical time, so different slots do not share a lock', async () => {
    const req = {
      user: { id: 1 },
      params: { userId: '1' },
      body: { serviceId: 7, booking_date: FUTURE_DATE_ISO, booking_time: '2:00 PM', notes: 'x' },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await createBooking(req, res);

    // The tagged-template call's raw strings/values are captured as separate
    // args by Prisma's $queryRaw mock signature: ([strings, ...values]).
    const [, lockKey] = tx.$executeRaw.mock.calls[0];
    expect(lockKey).toContain('42'); // vendorId
    expect(lockKey).toContain(FUTURE_DATE_KEY); // date
    expect(lockKey).toContain('14:00'); // canonical time (from "2:00 PM")
  });
});
