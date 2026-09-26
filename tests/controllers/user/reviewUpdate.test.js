/**
 * Regression test for audit #78: there was no way to edit a submitted
 * review at all -- the endpoint did not exist (the customer app's
 * updateReview call was a stub with nothing behind it).
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../../util/prisma.js', () => ({
  default: {
    review: { findUnique: jest.fn(), update: jest.fn() },
    $transaction: jest.fn((cb) => cb({
      review: { update: jest.fn().mockImplementation(async ({ data }) => ({ ...REVIEW_ROW, ...data })) },
    })),
  },
}));
jest.unstable_mockModule('../../../util/ratingHelper.js', () => ({
  updateVendorRatingStats: jest.fn(),
}));

const prisma = (await import('../../../util/prisma.js')).default;
const { updateVendorRatingStats } = await import('../../../util/ratingHelper.js');
const { updateReview } = await import('../../../controllers/user/reviewController.js');

const REVIEWER_ID = 501;
const OTHER_USER_ID = 999;
const REVIEW_ID = 42;
const VENDOR_ID = 601;

const REVIEW_ROW = {
  id: REVIEW_ID,
  userId: REVIEWER_ID,
  vendorId: VENDOR_ID,
  rating: 3,
  comment: 'Fine, nothing special.',
};

const mockReq = (body, userId = REVIEWER_ID) => ({
  params: { id: String(REVIEW_ID) },
  body,
  user: { id: userId },
});

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  prisma.review.findUnique.mockResolvedValue({ ...REVIEW_ROW });
  prisma.$transaction.mockImplementation((cb) => cb({
    review: { update: jest.fn().mockImplementation(async ({ data }) => ({ ...REVIEW_ROW, ...data })) },
  }));
});

describe('updateReview (audit #78)', () => {
  test('404s when the review does not exist', async () => {
    prisma.review.findUnique.mockResolvedValue(null);
    const res = mockRes();

    await updateReview(mockReq({ rating: 5 }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('403s when the caller does not own the review', async () => {
    const res = mockRes();

    await updateReview(mockReq({ rating: 5 }, OTHER_USER_ID), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('400s when neither rating nor comment is provided', async () => {
    const res = mockRes();

    await updateReview(mockReq({}), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOTHING_TO_UPDATE' }));
  });

  test('updates the rating and recomputes vendor stats', async () => {
    const res = mockRes();

    await updateReview(mockReq({ rating: 5 }), res);

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(updateVendorRatingStats).toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.rating).toBe(5);
  });

  test('updates only the comment without recomputing vendor stats', async () => {
    const res = mockRes();

    await updateReview(mockReq({ comment: 'Actually it was great.' }), res);

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(updateVendorRatingStats).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.comment).toBe('Actually it was great.');
  });
});
