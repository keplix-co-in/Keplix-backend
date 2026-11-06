import { jest } from '@jest/globals';

/**
 * Admin finance (2026-11-03):
 *  - GET /admin/finance/refunds lists refunds of every kind plus paid
 *    cancelled bookings still owed one ("needs_refund"),
 *  - the payout queue leaves out dead bookings and shows failed payouts,
 *  - the commission total counts booking payments only, not full refunds.
 */

const mockPrisma = {
  refund: { findMany: jest.fn(), aggregate: jest.fn() },
  payment: { findMany: jest.fn(), aggregate: jest.fn() },
};

jest.unstable_mockModule('../../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../queues/payoutQueue.js', () => ({ addPayoutJob: jest.fn() }));
jest.unstable_mockModule('razorpay', () => ({
  default: jest.fn().mockImplementation(() => ({ payments: { refund: jest.fn() } })),
}));

const { getRefunds, getPendingPayouts, getFinanceKpis } = await import(
  '../../../controllers/Admin/financeController.js'
);

const dec = (n) => ({ toString: () => String(n), valueOf: () => n });

const paymentSel = (overrides = {}) => ({
  id: 5,
  amount: dec(1000),
  transactionId: 'pay_5',
  status: 'success',
  vendorPayoutStatus: 'pending',
  booking: {
    id: 1760,
    status: 'cancelled',
    user: { id: 3, email: 'c@example.com' },
    service: { name: 'Car wash', vendor: { id: 9, vendorProfile: { business_name: 'Shine' } } },
  },
  ...overrides,
});

const call = async (handler, query = {}) => {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  await handler({ query }, res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.refund.findMany.mockResolvedValue([]);
  mockPrisma.payment.findMany.mockResolvedValue([]);
});

describe('getRefunds', () => {
  test('a paid cancelled booking with no refund shows as needs_refund, first', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([paymentSel()]);
    mockPrisma.refund.findMany.mockResolvedValue([
      { id: 1, paymentId: 6, amount: dec(200), status: 'processed', idempotencyKey: 'k', payment: paymentSel({ id: 6 }) },
    ]);

    const res = await call(getRefunds);
    const { items } = res.json.mock.calls[0][0];

    expect(items[0]).toMatchObject({
      kind: 'needs_refund', paymentId: 5, amount: 1000, bookingId: 1760,
      vendor: { id: 9, name: 'Shine' }, customer: { id: 3, email: 'c@example.com' },
    });
    expect(items[1]).toMatchObject({ kind: 'refund', group: 'refunded', amount: 200 });
  });

  test('"needs refund" means a paid, cancelled booking with nothing returned or on its way', async () => {
    await call(getRefunds, { status: 'needs_refund' });
    const { where } = mockPrisma.payment.findMany.mock.calls[0][0];
    expect(where.status).toBe('success');
    expect(where.booking.status.in).toEqual(expect.arrayContaining(['cancelled', 'refunded']));
    // A failed attempt is not in this list, so the booking still shows as owed.
    expect(where.refunds.none.status.in).toEqual(
      expect.arrayContaining(['initiated', 'gateway_confirmed', 'processed', 'reconciliation_needed']),
    );
    expect(where.refunds.none.status.in).not.toContain('gateway_failed');
    expect(mockPrisma.refund.findMany).not.toHaveBeenCalled();
  });

  test('filters map to refund statuses', async () => {
    await call(getRefunds, { status: 'processing' });
    expect(mockPrisma.refund.findMany.mock.calls[0][0].where.status.in.sort())
      .toEqual(['gateway_confirmed', 'initiated']);
    expect(mockPrisma.payment.findMany).not.toHaveBeenCalled();

    await call(getRefunds, { status: 'failed' });
    expect(mockPrisma.refund.findMany.mock.calls[1][0].where.status.in).toEqual(['gateway_failed']);
  });

  test('marks refunds made in the Razorpay dashboard', async () => {
    mockPrisma.refund.findMany.mockResolvedValue([
      { id: 2, paymentId: 5, amount: dec(1000), status: 'processed', idempotencyKey: 'dashboard:rfnd_x', payment: paymentSel() },
    ]);
    const res = await call(getRefunds, { status: 'refunded' });
    expect(res.json.mock.calls[0][0].items[0].fromDashboard).toBe(true);
  });

  test('an unknown filter is a 400', async () => {
    const res = await call(getRefunds, { status: 'nope' });
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('getPendingPayouts', () => {
  test('lists pending and failed payouts, never for a dead booking', async () => {
    await call(getPendingPayouts);
    const { where, select } = mockPrisma.payment.findMany.mock.calls[0][0];
    expect(where.vendorPayoutStatus.in).toEqual(['pending', 'failed']);
    expect(where.booking.status.notIn).toEqual(expect.arrayContaining(['cancelled', 'refunded', 'disputed']));
    expect(select.vendorPayoutStatus).toBe(true);
  });
});

describe('getFinanceKpis commission', () => {
  test('counts only successful booking payments', async () => {
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: {} });
    mockPrisma.refund.aggregate.mockResolvedValue({ _sum: {} });
    await call(getFinanceKpis);
    const commission = mockPrisma.payment.aggregate.mock.calls
      .map(([a]) => a)
      .find((a) => a._sum.platformFee);
    expect(commission.where).toEqual({
      bookingId: { not: null },
      // 2026-11-06: fully refunded on-top payments kept their fee.
      OR: [{ status: 'success' }, { status: 'refunded', feeModel: 'on_top' }],
    });
  });
});

describe('getFinanceKpis pending / failed', () => {
  test('a dead booking is not counted as owed to the vendor', async () => {
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: {} });
    mockPrisma.refund.aggregate.mockResolvedValue({ _sum: {} });
    await call(getFinanceKpis);
    const wheres = mockPrisma.payment.aggregate.mock.calls.map(([a]) => a.where);
    const pending = wheres.find((w) => w.vendorPayoutStatus?.in?.includes('pending'));
    const failed = wheres.find((w) => w.vendorPayoutStatus === 'failed');
    for (const w of [pending, failed]) {
      expect(w.booking.status.notIn).toEqual(expect.arrayContaining(['cancelled', 'refunded', 'disputed']));
    }
  });
});

describe('getFinanceKpis pending / failed', () => {
  test('a dead booking is not counted as owed to the vendor', async () => {
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: {} });
    mockPrisma.refund.aggregate.mockResolvedValue({ _sum: {} });
    await call(getFinanceKpis);
    const wheres = mockPrisma.payment.aggregate.mock.calls.map(([a]) => a.where);
    const pending = wheres.find((w) => w.vendorPayoutStatus?.in?.includes('pending'));
    const failed = wheres.find((w) => w.vendorPayoutStatus === 'failed');
    for (const w of [pending, failed]) {
      expect(w.booking.status.notIn).toEqual(expect.arrayContaining(['cancelled', 'refunded', 'disputed']));
    }
  });
});
