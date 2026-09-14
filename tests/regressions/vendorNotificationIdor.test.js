/**
 * Regression tests for the CONFIRMED IDOR defects in the vendor notification
 * controller, found by the 2026-09-12 codebase audit (security-auditor F8,
 * penetration-tester F36).
 *
 * `GET /interactions/api/vendor/users/:user_id/notifications` trusted the
 * `:user_id` URL param outright with no ownership or role check, so any
 * authenticated account could read any other account's notifications by
 * supplying a different id. `PUT /interactions/api/vendor/notifications/:id/mark-read`
 * updated by notification `id` alone, so any authenticated account could mark
 * (and thereby confirm the existence and content of) any other account's
 * notification as read.
 *
 * The fix: `getVendorNotifications` now ignores the untrusted `:user_id`
 * param entirely and always scopes by `req.user.id` (there is no admin
 * bypass on this route, so there is no legitimate case for reading anyone
 * else's notifications here). `markVendorRead` now matches on both `id` AND
 * `userId` via `updateMany`, so a mismatched owner matches zero rows (404)
 * instead of updating someone else's data.
 *
 * See tests/regressions/bookingStatusGuards.test.js for the file convention.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    notification: {
      findMany: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

const prisma = (await import('../../util/prisma.js')).default;
const { getVendorNotifications, markVendorRead } = await import(
  '../../controllers/vendor/notificationController.js'
);

const CALLER_ID = 501;
const VICTIM_ID = 999;

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  prisma.notification.findMany.mockResolvedValue([]);
  prisma.notification.count.mockResolvedValue(0);
});

describe('vendor notification IDOR — FIXED, regression guard', () => {
  test('getVendorNotifications ignores a spoofed :user_id and always scopes to the caller', async () => {
    const req = {
      params: { user_id: String(VICTIM_ID) }, // attacker tries to read someone else's notifications
      query: {},
      user: { id: CALLER_ID },
    };
    const res = mockRes();

    await getVendorNotifications(req, res);

    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: CALLER_ID }) })
    );
    expect(prisma.notification.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: VICTIM_ID }) })
    );
  });

  test('markVendorRead scopes the update by id AND caller id, not id alone', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 1 });
    const req = { params: { id: '42' }, user: { id: CALLER_ID } };
    const res = mockRes();

    await markVendorRead(req, res);

    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: 42, userId: CALLER_ID },
      data: { is_read: true },
    });
  });

  test('markVendorRead returns 404, not a silent success, when the notification belongs to someone else', async () => {
    // updateMany matches zero rows because userId doesn't match — this is
    // exactly what stops one account from marking another's notification.
    prisma.notification.updateMany.mockResolvedValue({ count: 0 });
    const req = { params: { id: '42' }, user: { id: CALLER_ID } };
    const res = mockRes();

    await markVendorRead(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('sanity check: a caller marking their own notification still succeeds', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 1 });
    const req = { params: { id: '42' }, user: { id: CALLER_ID } };
    const res = mockRes();

    await markVendorRead(req, res);

    expect(res.status).not.toHaveBeenCalledWith(404);
    expect(res.status).not.toHaveBeenCalledWith(500);
  });
});
