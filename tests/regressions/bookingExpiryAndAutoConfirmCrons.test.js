/**
 * Regression guards for the in-process booking crons
 * (util/bookingStatusManager.js), booking-flow plan 2026-10-20.
 *
 * Missed slot (handleExpiredBookings): a confirmed/scheduled booking more than
 * 30 minutes past its slot is STARTED LATE (in_progress), paid or not, with an
 * [ADMIN NOTICE] log. Changed 2026-10-24 from "cancel, and fully refund a paid
 * one": only this cron ever starts a normal booking (the partner app has no
 * Start button for one), so a booking only got this late when the cron had
 * not run -- Cloud Run scales the backend to zero. Cancelling punished a real
 * job for our downtime. The write is guarded, so a booking the customer
 * cancelled (or the vendor started) in the meantime is left alone.
 *
 * Auto-confirm: a booking left in service_completed past the window (48h by
 * default) is confirmed through the same confirmBookingAndQueuePayout as the
 * customer's Confirm button, which releases the payout. A dispute wins: if
 * the confirmation throws, nothing is announced. Rows with a NULL
 * service_completed_at (pre-dating the column) are excluded by the query.
 *
 * Mocked Prisma and services, no database.
 */
import { jest } from '@jest/globals';

// The window is read once at module load; pin the default for this suite
// whatever the local .env says.
delete process.env.BOOKING_AUTO_CONFIRM_HOURS;

const mockPrisma = {
  booking: { findMany: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
};

jest.unstable_mockModule('node-cron', () => ({ default: { schedule: jest.fn() } }));
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../util/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn() },
}));
jest.unstable_mockModule('../../util/notificationHelper.js', () => ({
  createNotification: jest.fn().mockResolvedValue(null),
  sendPushNotification: jest.fn().mockResolvedValue(null),
}));
jest.unstable_mockModule('../../services/refundPolicy.js', () => ({
  executeCancellationRefund: jest.fn(),
  resolveCancellationRefund: jest.fn(),
}));
jest.unstable_mockModule('../../services/refundService.js', () => ({
  RESERVED_STATUSES: ['pending', 'processing'],
}));
jest.unstable_mockModule('../../services/bookingConfirmationService.js', () => ({
  confirmBookingAndQueuePayout: jest.fn(),
  BookingConfirmationError: class extends Error {},
}));

const { default: manager } = await import('../../util/bookingStatusManager.js');
const { createNotification } = await import('../../util/notificationHelper.js');
const { executeCancellationRefund } = await import('../../services/refundPolicy.js');
const { confirmBookingAndQueuePayout } = await import('../../services/bookingConfirmationService.js');
const { default: Logger } = await import('../../util/logger.js');

const USER_ID = 31;
const VENDOR_ID = 41;

const expiringBooking = (overrides = {}) => ({
  id: 501,
  userId: USER_ID,
  status: 'confirmed',
  vendor_status: 'accepted',
  notes: '',
  service: { vendorId: VENDOR_ID, name: 'Full Service' },
  payment: null,
  ...overrides,
});

const notifiedTypes = (userId) =>
  createNotification.mock.calls
    .map(([arg]) => arg)
    .filter((arg) => arg.userId === userId)
    .map((arg) => arg.type);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('missed-slot cron (late start, no cancel/refund)', () => {
  const NOW = new Date();
  // The earliest day the query looks at, early morning: always well past the
  // 30-minute boundary, so handleExpiredBookings owns it.
  const longPast = (overrides = {}) =>
    expiringBooking({
      booking_date: manager.getActivationLowerBound(NOW),
      booking_time: '00:30',
      ...overrides,
    });

  test('a PAID booking long past its slot is started late with a guarded write: no cancel, no refund', async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      longPast({ payment: { id: 80, status: 'success', amount: 1200 } }),
    ]);
    mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

    await manager.handleExpiredBookings(NOW);

    expect(mockPrisma.booking.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 501, status: { in: ['confirmed', 'scheduled'] }, vendor_status: 'accepted' },
        data: expect.objectContaining({ status: 'in_progress' }),
      }),
    );
    const { data } = mockPrisma.booking.updateMany.mock.calls[0][0];
    expect(data.notes).toBeUndefined(); // no [Auto-cancelled marker
    expect(executeCancellationRefund).not.toHaveBeenCalled();
    // Same notifications an on-time start sends.
    expect(notifiedTypes(USER_ID)).toEqual(['SERVICE_STARTED']);
    expect(notifiedTypes(VENDOR_ID)).toEqual(['SERVICE_TIME_ARRIVED']);
    expect(Logger.warn).toHaveBeenCalledWith(expect.stringContaining('[ADMIN NOTICE] Booking 501 started'));
  });

  test('an UNPAID booking long past its slot is started late too (as an on-time tick would)', async () => {
    mockPrisma.booking.findMany.mockResolvedValue([longPast()]);
    mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

    await manager.handleExpiredBookings(NOW);

    expect(mockPrisma.booking.updateMany.mock.calls[0][0].data.status).toBe('in_progress');
    expect(executeCancellationRefund).not.toHaveBeenCalled();
    expect(notifiedTypes(USER_ID)).toEqual(['SERVICE_STARTED']);
  });

  test('a booking that changed state first (guarded count 0) is left alone: no notifications, no admin notice', async () => {
    mockPrisma.booking.findMany.mockResolvedValue([longPast()]);
    mockPrisma.booking.updateMany.mockResolvedValue({ count: 0 });

    await manager.handleExpiredBookings(NOW);

    expect(createNotification).not.toHaveBeenCalled();
    expect(Logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('[ADMIN NOTICE]'));
  });

  test('a booking whose slot is still ahead is not touched', async () => {
    const ahead = new Date(manager.getActivationLowerBound(NOW).getTime() + 3 * 24 * 60 * 60 * 1000);
    mockPrisma.booking.findMany.mockResolvedValue([longPast({ booking_date: ahead, booking_time: '23:30' })]);

    await manager.handleExpiredBookings(NOW);

    expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
  });

  test('the query no longer loads payment (nothing is refunded here any more)', async () => {
    mockPrisma.booking.findMany.mockResolvedValue([]);

    await manager.handleExpiredBookings(NOW);

    expect(mockPrisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ['confirmed', 'scheduled'] }, vendor_status: 'accepted' }),
        include: { service: true },
      }),
    );
  });

  test('the old cancel-and-refund path is gone', () => {
    expect(manager.expireBooking).toBeUndefined();
  });
});

describe('auto-confirm cron', () => {
  const NOW = new Date('2026-10-20T12:00:00.000Z');
  const completed = (id) => ({ id, userId: USER_ID, status: 'service_completed', service: { name: 'Full Service' } });

  test('queries service_completed bookings older than 48h, paid, with no refund in flight, and skips NULL timestamps', async () => {
    mockPrisma.booking.findMany.mockResolvedValue([]);

    await manager.autoConfirmCompletedBookings(NOW);

    const { where, orderBy, take } = mockPrisma.booking.findMany.mock.calls[0][0];
    expect(where.status).toBe('service_completed');
    expect(where.service_completed_at).toEqual({
      not: null,
      lt: new Date('2026-10-18T12:00:00.000Z'),
    });
    expect(where.payment).toEqual({
      is: {
        status: 'success',
        refunds: { none: { status: { in: ['pending', 'processing'] } } },
        // Review fix 2026-10-24: already-claimed payouts are excluded, or
        // they jam the batch (see the dedicated test below).
        OR: [
          { vendorPayoutStatus: null },
          { vendorPayoutStatus: { notIn: ['paid', 'settled', 'processing'] } },
        ],
      },
    });
    expect(orderBy).toEqual({ service_completed_at: 'asc' });
    expect(take).toBe(50);
  });

  test('confirms each candidate through the customer confirmation path (no rating) and notifies the customer', async () => {
    mockPrisma.booking.findMany.mockResolvedValue([completed(601), completed(602)]);
    confirmBookingAndQueuePayout.mockResolvedValue(undefined);

    const count = await manager.autoConfirmCompletedBookings(NOW);

    expect(count).toBe(2);
    expect(confirmBookingAndQueuePayout).toHaveBeenCalledWith({ userId: USER_ID, bookingId: 601 });
    expect(confirmBookingAndQueuePayout).toHaveBeenCalledWith({ userId: USER_ID, bookingId: 602 });
    expect(notifiedTypes(USER_ID)).toEqual(['SERVICE_AUTO_CONFIRMED', 'SERVICE_AUTO_CONFIRMED']);
  });

  test('a dispute that wins the race (confirmation throws) is skipped silently and the batch continues', async () => {
    mockPrisma.booking.findMany.mockResolvedValue([completed(603), completed(604)]);
    confirmBookingAndQueuePayout
      .mockRejectedValueOnce(new Error('Booking status has changed before it could be confirmed'))
      .mockResolvedValueOnce(undefined);

    const count = await manager.autoConfirmCompletedBookings(NOW);

    expect(count).toBe(1);
    expect(Logger.warn).toHaveBeenCalledWith(expect.stringContaining('603'));
    const notifiedIds = createNotification.mock.calls.map(([arg]) => arg.data?.bookingId);
    expect(notifiedIds).not.toContain(603);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  test('excludes exactly the payout statuses confirmBookingAndQueuePayout refuses, and keeps unclaimed ones', async () => {
    // Before this filter, rows an admin had settled by hand (or with a payout
    // already queued) matched every tick, sorted first, failed inside the
    // confirmation, and could fill the whole batch of 50 -- so no other
    // booking was ever auto-confirmed.
    mockPrisma.booking.findMany.mockResolvedValue([]);

    await manager.autoConfirmCompletedBookings(NOW);

    const { OR } = mockPrisma.booking.findMany.mock.calls[0][0].where.payment.is;
    const notIn = OR.find((c) => c.vendorPayoutStatus?.notIn).vendorPayoutStatus.notIn;
    expect([...notIn].sort()).toEqual(['paid', 'processing', 'settled']);
    for (const unclaimed of ['pending', 'failed', 'not_applicable']) {
      expect(notIn).not.toContain(unclaimed);
    }
    // SQL NOT IN never matches NULL, so NULL needs its own branch.
    expect(OR).toContainEqual({ vendorPayoutStatus: null });
  });

  test('a failing candidate query is logged and returns 0 instead of throwing out of the cron', async () => {
    mockPrisma.booking.findMany.mockRejectedValue(new Error('db down'));

    await expect(manager.autoConfirmCompletedBookings(NOW)).resolves.toBe(0);
    expect(confirmBookingAndQueuePayout).not.toHaveBeenCalled();
  });
});

describe('start()', () => {
  test('runs auto-confirm once at startup, not only on the 10-minute tick', async () => {
    // Cloud Run scales the backend to zero (--min-instances 0), so a cold
    // start may never live long enough to reach a */10 tick.
    mockPrisma.booking.findMany.mockResolvedValue([]);
    const spy = jest.spyOn(manager, 'autoConfirmCompletedBookings');
    manager.isRunning = false;

    manager.start();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBeInstanceOf(Date);
    spy.mockRestore();
    manager.isRunning = false;
  });
});
