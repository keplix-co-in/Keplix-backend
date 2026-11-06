import { jest } from '@jest/globals';

// Fee ON TOP refunds (owner decision 2026-11-06): Keplix keeps its fee, so
// only amount − platformFee is refundable; the vendor gets price − refunded.
// Legacy (feeModel null) payments keep the old full-amount behaviour.

const mockPrisma = {
  payment: { findUnique: jest.fn(), update: jest.fn() },
  refund: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  platformSettings: { findFirst: jest.fn().mockResolvedValue(null) },
  $queryRaw: jest.fn().mockResolvedValue([]),
  $transaction: jest.fn(),
};
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));

const mockGatewayRefund = jest.fn();
const mockPaymentFetch = jest.fn();
jest.unstable_mockModule('razorpay', () => ({
  default: jest.fn().mockImplementation(() => ({ payments: { refund: mockGatewayRefund, fetch: mockPaymentFetch } })),
}));

const { issueRefund, recomputeSplitAfterRefunds, recordDashboardRefund } = await import('../../services/refundService.js');
const { resolveCancellationRefund } = await import('../../services/refundPolicy.js');

const onTop = (o = {}) => ({
  id: 1, amount: '1100', platformFee: '100', vendorAmount: '1000', feeModel: 'on_top',
  status: 'success', transactionId: 'pay_1', vendorPayoutStatus: 'pending', ...o,
});
const legacy = (o = {}) => onTop({ amount: '1000', platformFee: '100', vendorAmount: '900', feeModel: null, ...o });

let stored;
beforeEach(() => {
  jest.clearAllMocks();
  stored = onTop();
  mockPrisma.$transaction.mockImplementation(async (cb) => cb({ $queryRaw: mockPrisma.$queryRaw, payment: mockPrisma.payment, refund: mockPrisma.refund }));
  mockPrisma.payment.findUnique.mockImplementation(async () => stored);
  mockPrisma.payment.update.mockImplementation(async ({ data }) => { stored = { ...stored, ...data }; return stored; });
  mockPrisma.refund.findUnique.mockResolvedValue(null);
  mockPrisma.refund.findMany.mockResolvedValue([]);
  mockPrisma.refund.create.mockImplementation(async ({ data }) => ({ id: 10, ...data }));
  mockPrisma.refund.update.mockImplementation(async ({ data }) => ({ id: 10, ...data }));
  mockGatewayRefund.mockResolvedValue({ id: 'rfnd_1', status: 'processed' });
});

describe('issueRefund — on_top keeps the fee', () => {
  test('default (full) refund is the vendor price only; fee kept, vendor owed 0', async () => {
    mockPrisma.refund.findMany.mockImplementation(async ({ where }) =>
      where.idempotencyKey ? [] : [{ amount: '1000' }]); // after the refund lands
    await issueRefund({ paymentId: 1, idempotencyKey: 'k1' });
    expect(mockGatewayRefund).toHaveBeenCalledWith('pay_1', expect.objectContaining({ amount: 100000 }));
    expect(stored.status).toBe('refunded');
    expect(Number(stored.platformFee)).toBe(100);
    expect(stored.vendorAmount).toBe(0);
  });

  test('cannot refund into the fee', async () => {
    await expect(issueRefund({ paymentId: 1, amount: 1050, idempotencyKey: 'k2' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(mockGatewayRefund).not.toHaveBeenCalled();
  });

  test('partial refund: vendor gets price − refunded, fee unchanged', async () => {
    mockPrisma.refund.findMany.mockImplementation(async ({ where }) =>
      where.idempotencyKey ? [] : [{ amount: '300' }]);
    await issueRefund({ paymentId: 1, amount: 300, idempotencyKey: 'k3' });
    expect(stored.status).toBe('success');
    expect(stored.vendorAmount).toBe(700);
    expect(Number(stored.platformFee)).toBe(100);
  });

  test('legacy payment: full amount is still refundable', async () => {
    stored = legacy();
    await issueRefund({ paymentId: 1, idempotencyKey: 'k4' });
    expect(mockGatewayRefund).toHaveBeenCalledWith('pay_1', expect.objectContaining({ amount: 100000 }));
    expect(stored.status).toBe('refunded');
  });
});

describe('recomputeSplitAfterRefunds', () => {
  test('on_top: two partial refunds -> vendor 1000-200-300, fee untouched', async () => {
    mockPrisma.refund.findMany.mockResolvedValue([{ amount: '200' }, { amount: '300' }]);
    expect(await recomputeSplitAfterRefunds(1)).toEqual({ platformFee: 100, vendorAmount: 500 });
    expect(mockPrisma.payment.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { vendorAmount: 500 } });
  });
  test('legacy: still re-splits 90/10 of what is left', async () => {
    stored = legacy();
    mockPrisma.refund.findMany.mockResolvedValue([{ amount: '200' }]);
    expect(await recomputeSplitAfterRefunds(1)).toEqual({ platformFee: 80, vendorAmount: 720 });
  });
});

describe('recordDashboardRefund — on_top', () => {
  test('refunding the whole vendor price marks refunded and zeroes the vendor share', async () => {
    mockPrisma.payment.findFirst = jest.fn().mockResolvedValue(stored);
    mockPrisma.refund.findFirst = jest.fn().mockResolvedValue(null);
    mockPrisma.refund.upsert = jest.fn().mockResolvedValue({ id: 11 });
    mockPrisma.refund.findMany.mockResolvedValue([{ amount: '1000' }]);
    await recordDashboardRefund({ id: 'rfnd_d', payment_id: 'pay_1', amount: 100000, status: 'processed' });
    expect(stored.status).toBe('refunded');
    expect(stored.vendorAmount).toBe(0);
  });
});

describe('resolveCancellationRefund — on_top', () => {
  const booking = { id: 5, status: 'confirmed' };
  test('refunds the vendor price less the gateway fee; platform fee kept', async () => {
    const d = await resolveCancellationRefund({
      booking, payment: onTop({ gatewayFee: '20' }), settings: { refundGatewayFeeBorneBy: 'customer' },
    });
    expect(d).toMatchObject({ eligible: true, amount: 980, feeDeducted: 20 });
  });
  test('legacy refunds the full amount less the gateway fee', async () => {
    const d = await resolveCancellationRefund({
      booking, payment: legacy({ gatewayFee: '20' }), settings: { refundGatewayFeeBorneBy: 'customer' },
    });
    expect(d).toMatchObject({ eligible: true, amount: 980 });
  });
});
