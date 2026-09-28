/**
 * Regression test for an unbounded `?limit=` on three customer-facing
 * endpoints, found by the 2026-09-28 customer-services-and-search audit.
 *
 * getAllServices, getServicesByVendor (controllers/user/serviceController.js)
 * and getHistory (controllers/user/garageController.js) took `Number(limit)`
 * straight from the query string into a Prisma `take` (and, for
 * getAllServices' location branch, a raw-SQL `LIMIT`) with no upper bound —
 * unlike getFeaturedServices, which already capped at 100. A request like
 * `?limit=999999999` asked the database to hand back the entire table in one
 * response. Fixed by applying the same `Math.min(100, Math.max(1, ...))` cap
 * getFeaturedServices already used.
 *
 * See tests/regressions/phoneOtpPruning.test.js for the file convention.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    $queryRaw: jest.fn(),
    service: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    serviceSegmentPrice: { findMany: jest.fn().mockResolvedValue([]) },
    booking: { findMany: jest.fn().mockResolvedValue([]) },
    walkInJob: { findMany: jest.fn().mockResolvedValue([]) },
  },
}));
jest.unstable_mockModule('../../util/logger.js', () => ({
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

const { getAllServices, getServicesByVendor } = await import('../../controllers/user/serviceController.js');
const { getHistory } = await import('../../controllers/user/garageController.js');
const prisma = (await import('../../util/prisma.js')).default;

function mockReq(overrides = {}) {
  return {
    query: {}, params: {}, protocol: 'https',
    get: jest.fn().mockReturnValue('example.com'),
    user: { id: 1 },
    ...overrides,
  };
}
function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => jest.clearAllMocks());

describe('customer service/garage list endpoints cap ?limit=', () => {
  it('getAllServices caps an oversized limit at 100 (Prisma path)', async () => {
    const req = mockReq({ query: { limit: '999999999' } });
    const res = mockRes();
    await getAllServices(req, res);

    expect(prisma.service.findMany.mock.calls[0][0].take).toBe(100);
  });

  it('getAllServices caps an oversized limit at 100 (raw-SQL location path)', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
    const req = mockReq({ query: { limit: '999999999', latitude: '28.6', longitude: '77.2' } });
    const res = mockRes();
    await getAllServices(req, res);

    // The LIMIT value is interpolated into the tagged-template SQL as one of
    // its values, not a bind param name — assert it against every call's
    // captured values rather than the query text.
    const usedHugeLimit = prisma.$queryRaw.mock.calls.some((call) =>
      call.some((arg) => Array.isArray(arg) === false && arg === 999999999)
    );
    expect(usedHugeLimit).toBe(false);
  });

  it('getServicesByVendor caps an oversized limit at 100', async () => {
    const req = mockReq({ params: { vendorId: '5' }, query: { limit: '999999999' } });
    const res = mockRes();
    await getServicesByVendor(req, res);

    expect(prisma.service.findMany.mock.calls[0][0].take).toBe(100);
  });

  it('getHistory caps an oversized limit at 100', async () => {
    const req = mockReq({ query: { limit: '999999999' } });
    const res = mockRes();
    await getHistory(req, res);

    const bookingTake = prisma.booking.findMany.mock.calls[0][0].take;
    const walkInTake = prisma.walkInJob.findMany.mock.calls[0][0].take;
    // getHistory over-fetches page*limit per side, so with page=1 that's
    // just limit — capped at 100, not 999999999.
    expect(bookingTake).toBeLessThanOrEqual(100);
    expect(walkInTake).toBeLessThanOrEqual(100);
  });
});
