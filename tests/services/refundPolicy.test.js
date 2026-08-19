import { jest } from '@jest/globals';

const mockPrisma = {
  payment: {
    update: jest.fn(),
  },
};

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: mockPrisma,
}));

// The gateway fee is read from the payment entity, not the refund call.
const mockPaymentsFetch = jest.fn();
jest.unstable_mockModule('razorpay', () => ({
  default: jest.fn().mockImplementation(() => ({
    payments: { fetch: mockPaymentsFetch },
  })),
}));

const mockIssueRefund = jest.fn();
jest.unstable_mockModule('../../services/refundService.js', () => ({
  issueRefund: mockIssueRefund,
  RESERVED_STATUSES: ['initiated', 'gateway_confirmed', 'processed', 'reconciliation_needed'],
}));

const mockGetPlatformSettings = jest.fn();
jest.unstable_mockModule('../../util/platformSettings.js', () => ({
  getPlatformSettings: mockGetPlatformSettings,
}));

const { resolveCancellationRefund, executeCancellationRefund } = await import(
  '../../services/refundPolicy.js'
);

function paymentFixture(overrides = {}) {
  return {
    id: 1,
    amount: { toString: () => '2499' },
    status: 'success',
    transactionId: 'pay_1',
    gatewayFee: null,
    ...overrides,
  };
}

function settingsFixture(overrides = {}) {
  return {
    autoRefundOnCancellation: true,
    refundGatewayFeeBorneBy: 'platform',
    payoutHoldHours: 24,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.payment.update.mockResolvedValue({});
  mockGetPlatformSettings.mockResolvedValue(settingsFixture());
  mockIssueRefund.mockResolvedValue({
    refund: { id: 10 },
    alreadyProcessed: false,
    payoutAlreadySettled: false,
  });
});

describe('resolveCancellationRefund', () => {
  test('refunds the full amount when the platform absorbs the gateway fee', async () => {
    const decision = await resolveCancellationRefund({
      booking: { id: 1, status: 'confirmed' },
      payment: paymentFixture(),
      settings: settingsFixture(),
    });

    expect(decision.eligible).toBe(true);
    expect(decision.amount).toBe(2499);
    expect(decision.feeDeducted).toBe(0);
    // No gateway call needed when the platform is absorbing the fee.
    expect(mockPaymentsFetch).not.toHaveBeenCalled();
  });

  test('deducts the gateway fee when the customer bears it', async () => {
    mockPaymentsFetch.mockResolvedValue({ fee: 5900 }); // paise, incl. tax

    const decision = await resolveCancellationRefund({
      booking: { id: 1, status: 'confirmed' },
      payment: paymentFixture(),
      settings: settingsFixture({ refundGatewayFeeBorneBy: 'customer' }),
    });

    expect(decision.eligible).toBe(true);
    expect(decision.amount).toBe(2440);
    expect(decision.feeDeducted).toBe(59);
  });

  // The safety rule: a failed lookup must never quietly short-change someone.
  test('refunds in full when the gateway fee cannot be determined', async () => {
    mockPaymentsFetch.mockRejectedValue(new Error('gateway unreachable'));

    const decision = await resolveCancellationRefund({
      booking: { id: 1, status: 'confirmed' },
      payment: paymentFixture(),
      settings: settingsFixture({ refundGatewayFeeBorneBy: 'customer' }),
    });

    expect(decision.eligible).toBe(true);
    expect(decision.amount).toBe(2499);
    expect(decision.feeDeducted).toBe(0);
  });

  test('uses a cached gatewayFee without calling the gateway again', async () => {
    const decision = await resolveCancellationRefund({
      booking: { id: 1, status: 'confirmed' },
      payment: paymentFixture({ gatewayFee: { toString: () => '59' } }),
      settings: settingsFixture({ refundGatewayFeeBorneBy: 'customer' }),
    });

    expect(decision.amount).toBe(2440);
    expect(mockPaymentsFetch).not.toHaveBeenCalled();
  });

  // Cancelling stops being a refund once the vendor has started work.
  test.each(['in_progress', 'service_completed', 'completed'])(
    'refuses an automatic refund once the booking is %s',
    async (status) => {
      const decision = await resolveCancellationRefund({
        booking: { id: 1, status },
        payment: paymentFixture(),
        settings: settingsFixture(),
      });

      expect(decision.eligible).toBe(false);
      expect(decision.code).toBe('WORK_ALREADY_STARTED');
    },
  );

  // Distinct from WORK_ALREADY_STARTED: reporting "once work has started" for
  // a booking that was simply cancelled earlier is plainly wrong, and this is
  // the state the preview endpoint hits when someone reopens a cancelled
  // booking.
  test.each(['cancelled', 'canceled'])(
    'reports ALREADY_CANCELLED, not WORK_ALREADY_STARTED, for a %s booking',
    async (status) => {
      const decision = await resolveCancellationRefund({
        booking: { id: 1, status },
        payment: paymentFixture(),
        settings: settingsFixture(),
      });

      expect(decision.eligible).toBe(false);
      expect(decision.code).toBe('ALREADY_CANCELLED');
      expect(decision.reason).not.toMatch(/work has started/i);
    },
  );

  test('is not eligible when there is no payment', async () => {
    const decision = await resolveCancellationRefund({
      booking: { id: 1, status: 'confirmed' },
      payment: null,
      settings: settingsFixture(),
    });

    expect(decision.eligible).toBe(false);
    expect(decision.code).toBe('NO_PAYMENT');
  });

  test('is not eligible when the payment never succeeded', async () => {
    const decision = await resolveCancellationRefund({
      booking: { id: 1, status: 'confirmed' },
      payment: paymentFixture({ status: 'pending' }),
      settings: settingsFixture(),
    });

    expect(decision.eligible).toBe(false);
    expect(decision.code).toBe('PAYMENT_NOT_SUCCESSFUL');
  });
});

describe('executeCancellationRefund', () => {
  test('does nothing when automatic refunds are disabled', async () => {
    mockGetPlatformSettings.mockResolvedValue(
      settingsFixture({ autoRefundOnCancellation: false }),
    );

    const result = await executeCancellationRefund({
      booking: { id: 1, status: 'confirmed' },
      payment: paymentFixture(),
    });

    expect(result.refunded).toBe(false);
    expect(result.code).toBe('AUTO_REFUND_DISABLED');
    expect(mockIssueRefund).not.toHaveBeenCalled();
  });

  // The key is derived from booking + amount so a double-tapped cancel
  // collapses onto the same refund instead of issuing a second one.
  test('issues the refund with a booking-derived idempotency key', async () => {
    const result = await executeCancellationRefund({
      booking: { id: 42, status: 'confirmed' },
      payment: paymentFixture(),
    });

    expect(result.refunded).toBe(true);
    expect(mockIssueRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: 1,
        amount: 2499,
        idempotencyKey: 'cancel_booking_42_2499.00',
      }),
    );
  });

  // The reason the key is derived rather than random: two cancel taps must
  // resolve to the SAME key, so refundService recognises the second as a
  // repeat of the first instead of reserving a second slice of the payment.
  // A random or timestamped key here would refund the customer twice.
  test('produces an identical idempotency key across repeated cancels', async () => {
    const args = { booking: { id: 42, status: 'confirmed' }, payment: paymentFixture() };

    await executeCancellationRefund(args);
    await executeCancellationRefund(args);

    expect(mockIssueRefund).toHaveBeenCalledTimes(2);
    const [first] = mockIssueRefund.mock.calls[0];
    const [second] = mockIssueRefund.mock.calls[1];
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
  });

  // refundService short-circuits a repeat rather than re-issuing; the policy
  // layer must pass that through truthfully instead of reporting a fresh
  // refund the customer might expect twice.
  test('passes through alreadyProcessed when refundService recognises a repeat', async () => {
    mockIssueRefund.mockResolvedValue({
      refund: { id: 10 },
      alreadyProcessed: true,
      payoutAlreadySettled: false,
    });

    const result = await executeCancellationRefund({
      booking: { id: 42, status: 'confirmed' },
      payment: paymentFixture(),
    });

    expect(result.refunded).toBe(true);
    expect(result.alreadyProcessed).toBe(true);
  });

  // Cancellation is already committed by the caller, so this must report
  // rather than throw.
  test('reports a gateway failure instead of throwing', async () => {
    mockIssueRefund.mockRejectedValue(new Error('Gateway refund failed'));

    const result = await executeCancellationRefund({
      booking: { id: 1, status: 'confirmed' },
      payment: paymentFixture(),
    });

    expect(result.refunded).toBe(false);
    expect(result.code).toBe('REFUND_FAILED');
  });

  test('surfaces payoutAlreadySettled so the clawback is not silent', async () => {
    mockIssueRefund.mockResolvedValue({
      refund: { id: 10 },
      alreadyProcessed: false,
      payoutAlreadySettled: true,
    });

    const result = await executeCancellationRefund({
      booking: { id: 1, status: 'confirmed' },
      payment: paymentFixture(),
    });

    expect(result.refunded).toBe(true);
    expect(result.payoutAlreadySettled).toBe(true);
  });
});
