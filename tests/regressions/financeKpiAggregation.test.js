/**
 * Regression tests for the CONFIRMED finance/dashboard KPI aggregation
 * defects, found by the 2026-09-12 codebase audit (test-automator F43,
 * business-analyst F2/F21, product-manager F91 -- four agents converging on
 * the same root causes independently).
 *
 * Two separate controllers, four distinct bugs, all from aggregating
 * `Payment` alone:
 *
 *  financeController.getFinanceKpis:
 *   1. `refunds` summed Payment.amount where status:'refunded', but
 *      refundService only sets that on a FULL refund -- every partial
 *      refund contributed zero.
 *   2. `totalCollected`/`commission` filtered status:'success' only, so a
 *      refund retroactively erased a payment from historical totals.
 *   3. `pendingDisbursement` missed vendorPayoutStatus:'processing' --
 *      payments stranded there (a payout enqueue failure) were invisible.
 *   4. `failed` had no `status` filter at all, unlike every sibling query.
 *
 *  dashBoardController.getDashboardMetrics:
 *   Walk-in job revenue (WalkInJob.amount_collected) was never included in
 *   GMV or platform revenue -- a vendor routing volume through walk-ins
 *   instead of app bookings paid zero platform fee and showed up nowhere on
 *   this dashboard.
 *
 * See tests/regressions/bookingStatusGuards.test.js for the file convention.
 */
import { jest } from '@jest/globals';

const mockPrisma = {
  payment: { aggregate: jest.fn() },
  refund: { aggregate: jest.fn() },
  walkInJob: { aggregate: jest.fn() },
  booking: { count: jest.fn() },
  user: { count: jest.fn() },
};

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../services/payoutService.js', () => ({
  claimAndQueuePayout: jest.fn(),
  PayoutError: class PayoutError extends Error {},
}));
jest.unstable_mockModule('../../services/refundService.js', () => ({
  issueRefund: jest.fn(),
  RefundError: class RefundError extends Error {},
  GATEWAY_REACHED_STATUSES: ['gateway_confirmed', 'processed', 'reconciliation_needed'],
}));

const { getFinanceKpis } = await import('../../controllers/Admin/financeController.js');
const { getDashboardMetrics } = await import('../../controllers/Admin/dashBoardController.js');

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const zeroAggregate = { _sum: {} };

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.payment.aggregate.mockResolvedValue(zeroAggregate);
  mockPrisma.refund.aggregate.mockResolvedValue(zeroAggregate);
  mockPrisma.walkInJob.aggregate.mockResolvedValue(zeroAggregate);
  mockPrisma.booking.count.mockResolvedValue(0);
  mockPrisma.user.count.mockResolvedValue(0);
});

describe('finance KPI aggregation — FIXED, regression guard', () => {
  test('refunds source from the Refund table with GATEWAY_REACHED_STATUSES, not Payment.status:refunded', async () => {
    await getFinanceKpis({}, mockRes());

    expect(mockPrisma.refund.aggregate).toHaveBeenCalledWith({
      _sum: { amount: true },
      where: { status: { in: ['gateway_confirmed', 'processed', 'reconciliation_needed'] } },
    });
    // No Payment.aggregate call should filter on status:"refunded" for the refunds figure.
    const paymentCalls = mockPrisma.payment.aggregate.mock.calls.map((c) => c[0]);
    expect(paymentCalls.some((c) => c.where?.status === 'refunded')).toBe(false);
  });

  test('totalCollected and commission include refunded payments, not status:success alone', async () => {
    await getFinanceKpis({}, mockRes());

    const calls = mockPrisma.payment.aggregate.mock.calls.map((c) => c[0]);
    const totalCollectedCall = calls.find((c) => c._sum.amount);
    const commissionCall = calls.find((c) => c._sum.platformFee);

    expect(totalCollectedCall.where.status).toEqual({ in: ['success', 'refunded'] });
    expect(commissionCall.where.status).toEqual({ in: ['success', 'refunded'] });
  });

  test('pendingDisbursement includes "processing", not just "pending"', async () => {
    await getFinanceKpis({}, mockRes());

    const calls = mockPrisma.payment.aggregate.mock.calls.map((c) => c[0]);
    const pendingCall = calls.find(
      (c) =>
        c._sum.vendorAmount &&
        Array.isArray(c.where?.vendorPayoutStatus?.in) &&
        c.where.vendorPayoutStatus.in.includes('pending')
    );
    expect(pendingCall.where.vendorPayoutStatus.in).toEqual(
      expect.arrayContaining(['pending', 'processing'])
    );
  });

  test('failed payouts are scoped to status:success, not left unfiltered', async () => {
    await getFinanceKpis({}, mockRes());

    const calls = mockPrisma.payment.aggregate.mock.calls.map((c) => c[0]);
    const failedCall = calls.find((c) => c.where?.vendorPayoutStatus === 'failed');
    expect(failedCall.where.status).toBe('success');
  });
});

describe('dashboard walk-in GMV — FIXED, regression guard', () => {
  test('todayGMV and platformRevenue include walk-in job revenue, not Payment alone', async () => {
    mockPrisma.payment.aggregate
      .mockResolvedValueOnce({ _sum: { amount: 1000 } }) // todayGMV (Payment)
      .mockResolvedValueOnce({ _sum: { platformFee: 100 } }) // platformRevenue (Payment)
      .mockResolvedValueOnce({ _sum: {} }) // pendingPayouts
    mockPrisma.walkInJob.aggregate
      .mockResolvedValueOnce({ _sum: { amount_collected: 500 } }) // walk-in GMV today
      .mockResolvedValueOnce({ _sum: { commission_amount: 0 } }); // walk-in commission

    const res = mockRes();
    await getDashboardMetrics({}, res);

    const body = res.json.mock.calls[0][0];
    expect(body.todayGMV).toBe(1500); // 1000 (Payment) + 500 (walk-in)
    expect(body.walkInGMVToday).toBe(500);
  });

  test('walk-in commission defaults honestly to 0 when commission_amount is null (v1: no commission applied)', async () => {
    mockPrisma.walkInJob.aggregate
      .mockResolvedValueOnce({ _sum: { amount_collected: null } })
      .mockResolvedValueOnce({ _sum: { commission_amount: null } });

    const res = mockRes();
    await getDashboardMetrics({}, res);

    const body = res.json.mock.calls[0][0];
    expect(body.walkInGMVToday).toBe(0);
  });
});
