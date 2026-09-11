/**
 * Regression tests for CONFIRMED vendor-side and scheduler defects.
 *
 * These defects have been FIXED; the tests are now ordinary regression guards.
 * See bookingStatusGuards.test.js for the convention.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    booking: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    service: { findUnique: jest.fn() },
    payment: { updateMany: jest.fn(), update: jest.fn() },
    healthSheet: { findFirst: jest.fn() },
    platformSettings: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.unstable_mockModule('../../queues/notificationQueue.js', () => ({
  addNotificationJob: jest.fn(),
}));
jest.unstable_mockModule('../../util/notificationHelper.js', () => ({
  createNotification: jest.fn(),
  sendPushNotification: jest.fn(),
}));

const prisma = (await import('../../util/prisma.js')).default;
const { updateBookingStatus } = await import('../../controllers/vendor/bookingController.js');

const VENDOR_ID = 601;
const BOOKING_ID = 9002;

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const mockReq = (body, params = {}) => ({
  params: { id: String(BOOKING_ID), vendorId: String(VENDOR_ID), ...params },
  body,
  user: { id: VENDOR_ID },
  files: undefined,
  app: { get: () => undefined },
});

/** A booking the vendor has NOT accepted and that has NOT been paid for. */
const unacceptedUnpaidBooking = (overrides = {}) => ({
  id: BOOKING_ID,
  userId: 501,
  serviceId: 1,
  status: 'pending',
  vendor_status: 'pending',
  payment: null,
  service: { id: 1, vendorId: VENDOR_ID, name: 'Full Service', price: 5000 },
  user: { id: 501, name: 'Test Customer' },
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  prisma.platformSettings.findFirst.mockResolvedValue({
    isHealthSheetRequired: false,
    payoutHoldHours: 24,
  });
  prisma.payment.updateMany.mockResolvedValue({ count: 0 });
  prisma.booking.update.mockImplementation(async ({ data }) => ({
    ...unacceptedUnpaidBooking(),
    ...data,
    service: { id: 1, vendorId: VENDOR_ID, name: 'Full Service', price: 5000 },
    user: { id: 501, name: 'Test Customer' },
  }));
});

describe('D3 — vendor status:"completed" is guarded', () => {
  /**
   * controllers/vendor/bookingController.js:236-254 validates the CURRENT status
   * only for two targets: 'in_progress' (requires confirmed/scheduled) and
   * 'service_completed' (requires in_progress or confirmed/scheduled).
   *
   * WAS: 'completed' had no branch at all, so it was reachable from ANY state --
   * including a booking the vendor never accepted and the customer never paid
   * for. The code comment at :270 acknowledges the partner app sends 'completed'.
   *
   * Two consequences:
   *   - work can be marked done on an unaccepted, unpaid booking;
   *   - 'completed' is a dead end, because confirmBookingAndQueuePayout requires
   *     exactly 'service_completed' -- so the payout strands in 'pending' with no
   *     path forward except a manual admin settle.
   */
  test('refuses to complete a booking the vendor never accepted', async () => {
    prisma.booking.findFirst.mockResolvedValue(unacceptedUnpaidBooking());
    const req = mockReq({ status: 'completed' });
    const res = mockRes();

    await updateBookingStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  /**
   * OPEN PRODUCT QUESTION, not a defect: completion does not require the booking
   * to have been paid. Adding that gate would break any cash-settled job, so it
   * is a policy decision rather than a bug fix. Note the PAYOUT path is already
   * safe -- confirmBookingAndQueuePayout re-checks payment.status === 'success'
   * under a row lock (services/bookingConfirmationService.js), so an unpaid
   * booking cannot release money regardless.
   */
  test('CURRENT POLICY: completion does not require payment', async () => {
    prisma.booking.findFirst.mockResolvedValue(
      unacceptedUnpaidBooking({ status: 'confirmed', vendor_status: 'accepted', payment: null }),
    );
    const req = mockReq({ status: 'completed' });
    const res = mockRes();

    await updateBookingStatus(req, res);

    expect(prisma.booking.update).toHaveBeenCalled();
  });

});

describe('D4 — auto-decline cron cannot overwrite a concurrent accept', () => {
  /**
   * WAS: util/bookingStatusManager.js filtered `vendor_status: 'pending'` in the
   * findMany, but the write was:
   *
   *     prisma.booking.update({ where: { id: booking.id }, ... })
   *
   * The guard was absent from the `where`. Between the read and the write a
   * vendor could accept the job; the cron then blindly overwrote it to
   * rejected/cancelled and the acceptance was lost silently.
   *
   * This is a genuine check-then-act race, not a theoretical one: the window is
   * one findMany plus a per-row service lookup (:253), so it is milliseconds wide
   * per booking but the loop runs every minute over every expired row.
   *
   * FIXED: now `updateMany` with the precondition repeated in the WHERE, and
   * `count === 0` is treated as "the vendor got there first" (skip, no notify).
   */
  test('the decline write is conditional on the row still being pending', async () => {
    const source = (await import('fs')).readFileSync(
      new URL('../../util/bookingStatusManager.js', import.meta.url),
      'utf8',
    );

    // Isolate handlePendingBookingsTimeout and inspect its write.
    const start = source.indexOf('async handlePendingBookingsTimeout');
    const end = source.indexOf('\n  async ', start + 10);
    const body = source.slice(start, end === -1 ? undefined : end);

    const declineWrite = body.slice(body.indexOf("vendor_status: 'rejected'") - 400,
                                   body.indexOf("vendor_status: 'rejected'"));

    expect(declineWrite).toMatch(/updateMany|vendor_status:\s*'pending'/);
  });
});

describe('D5 — vendor approval is reachable', () => {
  /**
   * WAS: VendorProfile.status defaulted to "pending" and no API path wrote it,
   * so a vendor who registered through the app could never be approved and never
   * appeared in searchVendorsByLocation, which filters WHERE status = 'approved'.
   *
   * FIXED: PATCH /admin/vendors/:id/status (Admin/vendorController.setVendorStatus)
   * writes the field, validated by validators/Admin/vendorValidator.js.
   *
   * Correction to the original finding: the field WAS reachable -- prisma/seed.js
   * sets "approved" on its seeded vendors, which is why two approved rows exist.
   * The real defect was narrower: vendors who register through the APP could
   * never be approved, so they never appeared in the location search. Five of the
   * seven vendors in the database are in exactly that state.
   */
  test('an admin code path writes VendorProfile.status', async () => {
    const { readFileSync, readdirSync, statSync } = await import('fs');
    const { join } = await import('path');
    const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'tests' || entry.startsWith('.')) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.js')) files.push(full);
      }
    };
    for (const dir of ['controllers', 'services', 'routes', 'util', 'middleware']) {
      try { walk(join(root, dir)); } catch { /* dir absent */ }
    }

    // A write looks like vendorProfile.update({... data: { status: 'approved' }})
    const writesApproval = files.some((f) => {
      const src = readFileSync(f, 'utf8');
      if (!/vendorProfile\.(update|updateMany|upsert)/.test(src)) return false;
      return /status:\s*["'](approved|rejected|suspended)["']/.test(src);
    });

    expect(writesApproval).toBe(true);
  });
});
