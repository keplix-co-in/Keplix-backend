import { jest } from '@jest/globals';

/**
 * Covers what happens to a refund after Razorpay accepts it (2026-11-03):
 *  - a 'pending' answer is NOT shown as done; only 'processed' is,
 *  - the webhook / reconciler outcome (applyGatewayRefundOutcome),
 *  - refunds made by hand in the Razorpay dashboard (recordDashboardRefund),
 *  - the vendor's share after a partial refund (owner rule: 90% of what is left).
 */

const mockPrisma = {
  payment: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  refund: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    upsert: jest.fn(),
  },
  $queryRaw: jest.fn().mockResolvedValue([]),
  $transaction: jest.fn(),
};

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../util/platformSettings.js', () => ({
  resolvePlatformFeeRate: jest.fn().mockResolvedValue(0.1),
}));

const mockGatewayRefund = jest.fn();
jest.unstable_mockModule('razorpay', () => ({
  default: jest.fn().mockImplementation(() => ({ payments: { refund: mockGatewayRefund } })),
}));

const {
  issueRefund,
  applyGatewayRefundOutcome,
  recordDashboardRefund,
  recomputeSplitAfterRefunds,
} = await import('../../services/refundService.js');

const dec = (n) => ({ toString: () => String(n) });

function payment(overrides = {}) {
  return {
    id: 1,
    amount: dec(1000),
    platformFee: dec(100),
    vendorAmount: dec(900),
    status: 'success',
    transactionId: 'pay_1',
    vendorPayoutStatus: 'pending',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (cb) =>
    cb({ $queryRaw: mockPrisma.$queryRaw, payment: mockPrisma.payment, refund: mockPrisma.refund }),
  );
  mockPrisma.payment.findUnique.mockResolvedValue(payment());
  mockPrisma.refund.findUnique.mockResolvedValue(null);
  mockPrisma.refund.findMany.mockResolvedValue([]);
  mockPrisma.refund.create.mockImplementation(async ({ data }) => ({ id: 10, attempts: 0, ...data }));
  mockPrisma.refund.update.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));
  mockPrisma.payment.update.mockImplementation(async ({ data }) => data);
});

const refundStatusWrites = () =>
  mockPrisma.refund.update.mock.calls.map(([arg]) => arg.data.status).filter(Boolean);

describe('issueRefund: done only when Razorpay says processed', () => {
  test('a "pending" answer leaves the refund gateway_confirmed, not processed', async () => {
    mockGatewayRefund.mockResolvedValue({ id: 'rfnd_1', status: 'pending' });
    const { refund } = await issueRefund({ paymentId: 1, amount: 200, idempotencyKey: 'k1' });
    expect(refund.status).toBe('gateway_confirmed');
    expect(refundStatusWrites()).not.toContain('processed');
  });

  test('a "processed" answer marks it processed', async () => {
    mockGatewayRefund.mockResolvedValue({ id: 'rfnd_1', status: 'processed' });
    const { refund } = await issueRefund({ paymentId: 1, amount: 200, idempotencyKey: 'k1' });
    expect(refund.status).toBe('processed');
  });

  test('refused while the vendor payout is being sent', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(payment({ vendorPayoutStatus: 'processing' }));
    await expect(issueRefund({ paymentId: 1, idempotencyKey: 'k1' })).rejects.toMatchObject({ statusCode: 409 });
    expect(mockGatewayRefund).not.toHaveBeenCalled();
  });
});

describe('partial refund: vendor gets 90% of what is left', () => {
  test('₹1000 paid, ₹200 refunded -> vendor ₹720, Keplix ₹80', async () => {
    mockPrisma.refund.findMany.mockResolvedValue([{ amount: dec(200) }]);
    const split = await recomputeSplitAfterRefunds(1);
    expect(split).toEqual({ platformFee: 80, vendorAmount: 720 });
  });

  test('keeps the payment\'s own rate across a second partial refund', async () => {
    // After the first ₹200 refund the row holds 80/720; a further ₹300 leaves ₹500.
    mockPrisma.payment.findUnique.mockResolvedValue(payment({ platformFee: dec(80), vendorAmount: dec(720) }));
    mockPrisma.refund.findMany.mockResolvedValue([{ amount: dec(200) }, { amount: dec(300) }]);
    expect(await recomputeSplitAfterRefunds(1)).toEqual({ platformFee: 50, vendorAmount: 450 });
  });

  test('a 0/0 split falls back to the configured rate, not 0%', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(payment({ platformFee: dec(0), vendorAmount: dec(0) }));
    mockPrisma.refund.findMany.mockResolvedValue([{ amount: dec(200) }]);
    expect(await recomputeSplitAfterRefunds(1)).toEqual({ platformFee: 80, vendorAmount: 720 });
  });

  test('not rewritten once the payout is already sent', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(payment({ vendorPayoutStatus: 'paid' }));
    expect(await recomputeSplitAfterRefunds(1)).toBeNull();
    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
  });
});

describe('applyGatewayRefundOutcome', () => {
  const row = (status) => ({ id: 10, paymentId: 1, status });

  test('processed: gateway_confirmed -> processed', async () => {
    const { changed } = await applyGatewayRefundOutcome(row('gateway_confirmed'), 'processed', { id: 'rfnd_1' });
    expect(changed).toBe(true);
    expect(refundStatusWrites()).toEqual(['processed']);
  });

  test('processed twice is a no-op', async () => {
    const { changed } = await applyGatewayRefundOutcome(row('processed'), 'processed');
    expect(changed).toBe(false);
    expect(mockPrisma.refund.update).not.toHaveBeenCalled();
  });

  test('failed: marks gateway_failed, puts a refunded payment back to success, restores the vendor share', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(payment({ status: 'refunded' }));
    const { changed } = await applyGatewayRefundOutcome(row('gateway_confirmed'), 'failed', {
      error_description: 'Bank rejected',
    });
    expect(changed).toBe(true);
    expect(mockPrisma.refund.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'gateway_failed', lastError: 'Bank rejected' }) }),
    );
    expect(mockPrisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'success' } }),
    );
    // No refunds left that reached the customer -> full ₹900 back to the vendor.
    expect(mockPrisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { platformFee: 100, vendorAmount: 900 } }),
    );
  });

  test('a stale failure never undoes a processed refund', async () => {
    const { changed } = await applyGatewayRefundOutcome(row('processed'), 'failed');
    expect(changed).toBe(false);
    expect(mockPrisma.refund.update).not.toHaveBeenCalled();
    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
  });
});

describe('recordDashboardRefund', () => {
  const entity = (amountPaise, status = 'processed') => ({
    id: 'rfnd_dash', payment_id: 'pay_1', amount: amountPaise, status,
  });

  beforeEach(() => {
    mockPrisma.payment.findFirst.mockResolvedValue(payment());
    mockPrisma.refund.upsert.mockImplementation(async ({ create }) => ({ id: 20, ...create }));
  });

  test('our own refund whose webhook beat issueRefund is not recorded twice', async () => {
    // Razorpay echoes our idempotency key as receipt; that row already exists.
    mockPrisma.refund.findFirst.mockResolvedValue({ id: 7, idempotencyKey: 'key-1', status: 'initiated' });
    const result = await recordDashboardRefund({ ...entity(20000), receipt: 'key-1' });
    expect(result.ours).toMatchObject({ id: 7 });
    expect(mockPrisma.refund.findFirst).toHaveBeenCalledWith({ where: { idempotencyKey: 'key-1' } });
    expect(mockPrisma.refund.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
  });

  test('a payment that is not ours is ignored', async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(null);
    expect(await recordDashboardRefund(entity(100000))).toBeNull();
    expect(mockPrisma.refund.upsert).not.toHaveBeenCalled();
  });

  test('creates one row keyed on the Razorpay refund id, so a repeat webhook makes no duplicate', async () => {
    mockPrisma.refund.findMany.mockResolvedValue([{ amount: dec(1000) }]);
    const { refund } = await recordDashboardRefund(entity(100000));
    const arg = mockPrisma.refund.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ idempotencyKey: 'dashboard:rfnd_dash' });
    expect(arg.update).toEqual({});
    expect(refund).toMatchObject({ amount: 1000, status: 'processed', gatewayRefundId: 'rfnd_dash' });
  });

  test('a full dashboard refund marks the payment refunded', async () => {
    mockPrisma.refund.findMany.mockResolvedValue([{ amount: dec(1000) }]);
    await recordDashboardRefund(entity(100000));
    expect(mockPrisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'refunded' } }),
    );
  });

  test('a partial dashboard refund cuts the vendor share to 90% of what is left', async () => {
    mockPrisma.refund.findMany.mockResolvedValue([{ amount: dec(200) }]);
    await recordDashboardRefund(entity(20000));
    expect(mockPrisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { platformFee: 80, vendorAmount: 720 } }),
    );
  });

  test('flags when the vendor was already paid', async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(payment({ vendorPayoutStatus: 'paid' }));
    mockPrisma.refund.findMany.mockResolvedValue([{ amount: dec(200) }]);
    const { payoutAlreadySettled } = await recordDashboardRefund(entity(20000));
    expect(payoutAlreadySettled).toBe(true);
  });
});
