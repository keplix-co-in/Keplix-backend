/**
 * Regression test for the CONFIRMED IDOR in `getReviews` found by the
 * 2026-09-12 codebase audit (F106).
 *
 * `GET /interactions/api/reviews?user_id=<id>` trusted the `user_id` query
 * param outright, behind only `protect` (any authenticated account, not
 * ownership). Any authenticated account could pass another account's id and
 * read their full review + booking history, including the reviewer's name
 * and profile photo.
 *
 * The fix: `user_id` is only honoured when it equals `req.user.id`; any other
 * value is rejected with 403 before the query runs. `vendor_id` is
 * unaffected -- a vendor's reviews are public by design.
 *
 * See tests/regressions/vendorNotificationIdor.test.js for the file
 * convention this follows.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    review: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));

const prisma = (await import('../../util/prisma.js')).default;
const { getReviews } = await import('../../controllers/user/reviewController.js');

const CALLER_ID = 501;
const VICTIM_ID = 999;

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const mockReq = (query) => ({
  query,
  user: { id: CALLER_ID },
  protocol: 'https',
  get: () => 'api.keplix.co.in',
});

beforeEach(() => {
  jest.clearAllMocks();
  prisma.review.count.mockResolvedValue(0);
  prisma.review.findMany.mockResolvedValue([]);
});

describe('getReviews IDOR guard (audit #106)', () => {
  test('rejects a user_id that is not the caller\'s own id', async () => {
    const req = mockReq({ user_id: String(VICTIM_ID) });
    const res = mockRes();

    await getReviews(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: 'FORBIDDEN' }),
    );
    expect(prisma.review.findMany).not.toHaveBeenCalled();
  });

  test('allows a user_id equal to the caller\'s own id', async () => {
    const req = mockReq({ user_id: String(CALLER_ID) });
    const res = mockRes();

    await getReviews(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(prisma.review.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: CALLER_ID } }),
    );
  });

  test('still allows browsing a vendor\'s public reviews by vendor_id', async () => {
    const req = mockReq({ vendor_id: '42' });
    const res = mockRes();

    await getReviews(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(prisma.review.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { vendorId: 42 } }),
    );
  });
});
