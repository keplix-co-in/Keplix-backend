import { jest } from '@jest/globals';

/**
 * Founder dashboard sales (2026-11-14): IST day buckets, refunded payments
 * still count as collected, failed payments listed, only gateway-reached
 * refunds shown, and a DB error returns 500 without leaking details.
 */

const mockPrisma = {
  payment: { findMany: jest.fn() },
  refund: { findMany: jest.fn() },
};

jest.unstable_mockModule('../../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('razorpay', () => ({
  default: jest.fn().mockImplementation(() => ({ payments: { refund: jest.fn() } })),
}));

const { getFounderSales, istDayKey } = await import('../../../controllers/Admin/founderController.js');
const { GATEWAY_REACHED_STATUSES } = await import('../../../services/refundService.js');

const call = async () => {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  await getFounderSales({ query: {} }, res);
  return res;
};

// Fixed "now": 2026-11-14 10:00 IST = 04:30 UTC.
const NOW = new Date('2026-11-14T04:30:00.000Z');

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
  mockPrisma.payment.findMany.mockReset();
  mockPrisma.refund.findMany.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  console.error.mockRestore();
});

describe('istDayKey', () => {
  it('uses India time, so 20:00 UTC is already the next IST day', () => {
    expect(istDayKey('2026-11-13T20:00:00.000Z')).toBe('2026-11-14');
    expect(istDayKey('2026-11-13T18:00:00.000Z')).toBe('2026-11-13');
  });
});

describe('getFounderSales', () => {
  it('buckets by IST day and compares yesterday with the same day last week', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      { id: 1, amount: 500, status: 'success', method: 'upi', bookingId: 1, createdAt: new Date('2026-11-14T02:00:00Z') }, // today IST
      { id: 2, amount: 300, status: 'refunded', method: 'upi', bookingId: 2, createdAt: new Date('2026-11-13T10:00:00Z') }, // yesterday
      { id: 3, amount: 200, status: 'success', method: 'card', bookingId: 3, createdAt: new Date('2026-11-12T20:00:00Z') }, // 13 Nov IST = yesterday
      { id: 4, amount: 999, status: 'failed', method: 'upi', bookingId: 4, createdAt: new Date('2026-11-13T11:00:00Z') },
      { id: 5, amount: 150, status: 'success', method: 'upi', bookingId: 5, createdAt: new Date('2026-11-06T06:00:00Z') }, // same day last week
      { id: 6, amount: 70, status: 'pending', method: 'upi', bookingId: 6, createdAt: new Date('2026-11-14T03:00:00Z') },
    ]);
    mockPrisma.refund.findMany.mockResolvedValue([
      { id: 9, paymentId: 2, amount: 300, status: GATEWAY_REACHED_STATUSES[0], reason: 'cancel', createdAt: new Date('2026-11-13T12:00:00Z') },
      { id: 10, paymentId: 3, amount: 50, status: 'initiated', reason: null, createdAt: new Date('2026-11-13T12:00:00Z') },
    ]);

    const res = await call();
    const body = res.json.mock.calls[0][0];

    expect(body.today).toEqual({ amount: 500, count: 1 });
    expect(body.yesterday).toEqual({ amount: 500, count: 2 });
    expect(body.sameDayLastWeek).toEqual({ amount: 150, count: 1 });
    // 60 IST days, oldest first, today last (2026-11-14: 7/14/30 + previous period).
    expect(body.chart).toHaveLength(60);
    expect(body.chart[59]).toEqual({ date: '2026-11-14', amount: 500, count: 1 });
    expect(body.chart[0].date).toBe('2026-09-16');
    expect(body.failed.map((f) => f.id)).toEqual([4]);
    expect(body.refunds.map((r) => r.id)).toEqual([9]);
  });

  it('reads only from 59 IST days back (60-day chart)', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([]);
    mockPrisma.refund.findMany.mockResolvedValue([]);
    await call();
    const since = mockPrisma.payment.findMany.mock.calls[0][0].where.createdAt.gte;
    // 00:00 IST on 16 Sep = 18:30 UTC on 15 Sep.
    expect(since.toISOString()).toBe('2026-09-15T18:30:00.000Z');
    expect(mockPrisma.refund.findMany.mock.calls[0][0].where.createdAt.gte).toEqual(since);
  });

  it('charts old days but keeps failed/refunds to the last 14 days', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      { id: 1, amount: 200, status: 'success', method: 'upi', bookingId: 1, createdAt: new Date('2026-10-01T06:00:00Z') },
      { id: 2, amount: 90, status: 'failed', method: 'upi', bookingId: 2, createdAt: new Date('2026-10-01T06:00:00Z') },
      { id: 3, amount: 90, status: 'failed', method: 'upi', bookingId: 3, createdAt: new Date('2026-11-10T06:00:00Z') },
    ]);
    mockPrisma.refund.findMany.mockResolvedValue([
      { id: 8, paymentId: 1, amount: 200, status: GATEWAY_REACHED_STATUSES[0], reason: null, createdAt: new Date('2026-10-02T06:00:00Z') },
    ]);
    const body = (await call()).json.mock.calls[0][0];
    expect(body.chart.find((d) => d.date === '2026-10-01')).toEqual({ date: '2026-10-01', amount: 200, count: 1 });
    expect(body.failed.map((f) => f.id)).toEqual([3]);
    expect(body.refunds).toEqual([]);
  });

  it('returns zeros on an empty database', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([]);
    mockPrisma.refund.findMany.mockResolvedValue([]);
    const body = (await call()).json.mock.calls[0][0];
    expect(body.today).toEqual({ amount: 0, count: 0 });
    expect(body.chart.every((d) => d.amount === 0)).toBe(true);
  });

  it('returns 500 with a generic message when the DB fails', async () => {
    mockPrisma.payment.findMany.mockRejectedValue(new Error('db down'));
    mockPrisma.refund.findMany.mockResolvedValue([]);
    const res = await call();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'Failed to load founder sales' });
  });
});
