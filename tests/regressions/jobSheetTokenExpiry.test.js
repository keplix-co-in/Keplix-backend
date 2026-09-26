/**
 * Regression test for audit #115: `token_expires_at` existed on WalkInJob
 * but nothing ever set or checked it, so the public, unauthenticated
 * tracking link (sent over SMS/WhatsApp, living forever in message history)
 * never expired.
 *
 * The fix: walkInJobController sets it 90 days out on creation;
 * jobSheetController rejects a token whose expiry has passed with the same
 * generic 404 used for an unknown token (never distinguish "expired" from
 * "never existed" to an unauthenticated caller).
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    walkInJob: { findUnique: jest.fn() },
    healthSheet: { findUnique: jest.fn() },
  },
}));

const prisma = (await import('../../util/prisma.js')).default;
const { getJobSheetByToken } = await import('../../controllers/public/jobSheetController.js');

const mockRes = () => {
  const res = {};
  res.set = jest.fn().mockReturnValue(res);
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const BASE_JOB = {
  status: 'open',
  customer_name: 'Test Customer',
  vehicle: null,
  vendor: { vendorProfile: { business_name: 'Test Garage', city: 'Delhi' } },
  description: null,
  amount_collected: null,
  started_at: null,
  completed_at: null,
  healthSheet: null,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getJobSheetByToken token expiry (audit #115)', () => {
  test('404s a token whose expiry is in the past', async () => {
    prisma.walkInJob.findUnique.mockResolvedValue({
      ...BASE_JOB,
      token_expires_at: new Date(Date.now() - 1000),
    });

    const res = mockRes();
    await getJobSheetByToken({ params: { token: 'expired' } }, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Not found' });
  });

  test('serves a token whose expiry is in the future', async () => {
    prisma.walkInJob.findUnique.mockResolvedValue({
      ...BASE_JOB,
      token_expires_at: new Date(Date.now() + 1000 * 60 * 60),
    });

    const res = mockRes();
    await getJobSheetByToken({ params: { token: 'valid' } }, res);

    expect(res.status).not.toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ type: 'walk_in' }));
  });

  test('serves a token with no expiry set (legacy rows, null means unset not expired)', async () => {
    prisma.walkInJob.findUnique.mockResolvedValue({
      ...BASE_JOB,
      token_expires_at: null,
    });

    const res = mockRes();
    await getJobSheetByToken({ params: { token: 'legacy' } }, res);

    expect(res.status).not.toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ type: 'walk_in' }));
  });
});
