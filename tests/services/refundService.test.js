import { jest } from '@jest/globals';

const mockPrisma = {
  payment: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  refund: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  // The reservation step runs inside an interactive transaction that takes a
  // SELECT ... FOR UPDATE row lock, so the mock has to supply both. The `tx`
  // handed to the callback aliases the same refund/payment mocks, which keeps
  // the existing assertions on mockPrisma.refund.* working unchanged.
  $queryRaw: jest.fn().mockResolvedValue([]),
  $transaction: jest.fn(),
};

mockPrisma.$transaction.mockImplementation(async (cb) =>
  cb({
    $queryRaw: mockPrisma.$queryRaw,
    payment: mockPrisma.payment,
    refund: mockPrisma.refund,
  }),
);

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: mockPrisma,
}));

const mockRefundCreate = jest.fn();
jest.unstable_mockModule('razorpay', () => ({
  default: jest.fn().mockImplementation(() => ({
    payments: { refund: mockRefundCreate },
  })),
}));

const { issueRefund, RefundError } = await import('../../services/refundService.js');

function paymentFixture(overrides = {}) {
  return {
    id: 1,
    amount: { toString: () => '5000' },
    status: 'success',
    transactionId: 'pay_1',
    vendorPayoutStatus: 'pending',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$queryRaw.mockResolvedValue([]);
  mockPrisma.$transaction.mockImplementation(async (cb) =>
    cb({
      $queryRaw: mockPrisma.$queryRaw,
      payment: mockPrisma.payment,
      refund: mockPrisma.refund,
    }),
  );
  mockPrisma.refund.findUnique.mockResolvedValue(null);
  mockPrisma.refund.findMany.mockResolvedValue([]);
  mockPrisma.refund.create.mockImplementation(async ({ data }) => ({ id: 10, attempts: 0, ...data }));
  mockPrisma.refund.update.mockImplementation(async ({ data }) => ({ id: 10, ...data }));
  mockRefundCreate.mockResolvedValue({ id: 'rfnd_1', status: 'processed' });
});

describe('issueRefund', () => {
  test('rejects a payment that is not successful', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(paymentFixture({ status: 'pending' }));

    await expect(
      issueRefund({ paymentId: 1, idempotencyKey: 'k1' }),
    ).rejects.toBeInstanceOf(RefundError);
  });

  test('requires an idempotencyKey', async () => {
    await expect(
      issueRefund({ paymentId: 1 }),
    ).rejects.toBeInstanceOf(RefundError);
  });

  test('issues a full refund and marks the payment refunded', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(paymentFixture());

    const result = await issueRefund({ paymentId: 1, idempotencyKey: 'k1' });

    expect(mockRefundCreate).toHaveBeenCalledWith('pay_1', expect.objectContaining({ amount: 500000 }));
    expect(mockPrisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'refunded' } }),
    );
    expect(result.isFullRefund).toBe(true);
  });

  test('rejects a refund amount larger than what remains', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(paymentFixture());

    await expect(
      issueRefund({ paymentId: 1, amount: 10000, idempotencyKey: 'k1' }),
    ).rejects.toBeInstanceOf(RefundError);
  });

  test('replaying the same idempotencyKey after success returns the existing refund without calling the gateway again', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(paymentFixture());
    mockPrisma.refund.findUnique.mockResolvedValue({
      id: 10,
      status: 'processed',
      amount: { toString: () => '5000' },
    });

    const result = await issueRefund({ paymentId: 1, idempotencyKey: 'k1' });

    expect(mockRefundCreate).not.toHaveBeenCalled();
    expect(result.alreadyProcessed).toBe(true);
  });

  test('an in-flight "initiated" refund reserves its amount against the remaining balance', async () => {
    // Regression test for the over-refund race. Before the fix, only refunds
    // that had already reached the gateway counted against the balance, so a
    // concurrent refund that had merely been created ('initiated') was
    // invisible and both could pass the remaining-amount check. A ₹3000
    // reservation on a ₹5000 payment must leave only ₹2000 refundable.
    mockPrisma.payment.findUnique.mockResolvedValue(paymentFixture());
    mockPrisma.refund.findMany.mockResolvedValue([
      { amount: { toString: () => '3000' }, status: 'initiated' },
    ]);

    await expect(
      issueRefund({ paymentId: 1, amount: 2500, idempotencyKey: 'k2' }),
    ).rejects.toBeInstanceOf(RefundError);

    // And the gateway must never have been reached for the rejected amount.
    expect(mockRefundCreate).not.toHaveBeenCalled();
  });

  test('the reservation is taken under a row lock', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(paymentFixture());

    await issueRefund({ paymentId: 1, idempotencyKey: 'k1' });

    // A SELECT ... FOR UPDATE must have been issued inside the transaction —
    // without it the balance check and the row creation are separable and the
    // over-refund race reopens.
    expect(mockPrisma.$transaction).toHaveBeenCalled();
    expect(mockPrisma.$queryRaw).toHaveBeenCalled();
  });

  test('flags payoutAlreadySettled when the vendor was already paid out', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(paymentFixture({ vendorPayoutStatus: 'paid' }));

    const result = await issueRefund({ paymentId: 1, idempotencyKey: 'k1' });

    expect(result.payoutAlreadySettled).toBe(true);
  });

  test('a gateway failure marks the refund row gateway_failed and surfaces a 502', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(paymentFixture());
    mockRefundCreate.mockRejectedValue(new Error('gateway down'));

    await expect(
      issueRefund({ paymentId: 1, idempotencyKey: 'k1' }),
    ).rejects.toMatchObject({ statusCode: 502 });

    expect(mockPrisma.refund.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'gateway_failed' }) }),
    );
  });
});
