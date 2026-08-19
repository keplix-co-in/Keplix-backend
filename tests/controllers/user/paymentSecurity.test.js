import { jest } from '@jest/globals';
import crypto from 'node:crypto';

// These tests exercise the REAL service/controller code (services/paymentService.js,
// controllers/user/paymentController.js), not a local re-implementation. The
// previous suite (paymentController.test.js) reimplemented createPaymentOrder's
// logic inline, so it could never catch a regression in the actual controller —
// each test below is a regression test for a specific exploit that was possible
// before this patch.

const mockPrisma = {
  booking: {
    findUnique: jest.fn(),
  },
  payment: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
  $transaction: jest.fn(async (cb) =>
    cb({
      // The write path takes a SELECT ... FOR UPDATE on the booking row to
      // serialise concurrent verifies, so the fake tx must provide $queryRaw.
      $queryRaw: jest.fn().mockResolvedValue([]),
      payment: { upsert: mockPrisma.payment.upsert },
      booking: { update: jest.fn().mockResolvedValue({ id: 1, service: { vendorId: 42 } }) },
    }),
  ),
};

jest.unstable_mockModule('../../../util/prisma.js', () => ({
  default: mockPrisma,
}));

const mockPaymentsFetch = jest.fn();
jest.unstable_mockModule('razorpay', () => ({
  default: jest.fn().mockImplementation(() => ({
    payments: { fetch: mockPaymentsFetch },
  })),
}));

const { verifyAndRecordPayment, PaymentError } = await import(
  '../../../services/paymentService.js'
);

const RAZORPAY_SECRET = 'test_secret';

function capturedPaymentFixture(overrides = {}) {
  return {
    id: 'pay_1',
    order_id: 'order_1',
    status: 'captured',
    amount: 500000, // 5000 rupees in paise, matches bookingFixture's price
    ...overrides,
  };
}

function bookingFixture(overrides = {}) {
  return {
    id: 1,
    userId: 7,
    status: 'pending',
    service: { id: 1, price: { toString: () => '5000' }, vendorId: 42 },
    ...overrides,
  };
}

function validSignature(orderId, paymentId) {
  return crypto
    .createHmac('sha256', RAZORPAY_SECRET)
    .update(orderId + '|' + paymentId)
    .digest('hex');
}

beforeAll(() => {
  process.env.RAZORPAY_KEY_SECRET = RAZORPAY_SECRET;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.payment.findUnique.mockResolvedValue(null);
  mockPrisma.payment.upsert.mockImplementation(async ({ create }) => ({
    id: 99,
    ...create,
  }));
  mockPaymentsFetch.mockResolvedValue(capturedPaymentFixture());
});

describe('verifyAndRecordPayment — exploit regressions', () => {
  test('rejects a self-reported "upi" gateway with no signature (V1: free booking)', async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(bookingFixture());

    await expect(
      verifyAndRecordPayment({
        bookingId: 1,
        requestingUserId: 7,
        gateway: 'upi',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects a self-reported "cash" gateway (V1: free booking)', async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(bookingFixture());

    await expect(
      verifyAndRecordPayment({
        bookingId: 1,
        requestingUserId: 7,
        gateway: 'cash',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects verifying a booking that belongs to a different user (V3: cross-user confirm)', async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(bookingFixture({ userId: 7 }));

    const signature = validSignature('order_1', 'pay_1');

    await expect(
      verifyAndRecordPayment({
        bookingId: 1,
        requestingUserId: 999, // not the booking owner
        orderId: 'order_1',
        paymentId: 'pay_1',
        signature,
        gateway: 'razorpay',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test('rejects a forged signature', async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(bookingFixture());

    await expect(
      verifyAndRecordPayment({
        bookingId: 1,
        requestingUserId: 7,
        orderId: 'order_1',
        paymentId: 'pay_1',
        signature: 'not_the_real_signature',
        gateway: 'razorpay',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('accepts a valid signature from the booking owner and derives amount from service.price, not the client', async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(bookingFixture());
    const signature = validSignature('order_1', 'pay_1');

    const result = await verifyAndRecordPayment({
      bookingId: 1,
      requestingUserId: 7,
      orderId: 'order_1',
      paymentId: 'pay_1',
      signature,
      gateway: 'razorpay',
      // A tampered/absent amount from the client must have no effect —
      // the service layer never reads params.amount at all.
    });

    expect(mockPrisma.payment.upsert).toHaveBeenCalledTimes(1);
    const createData = mockPrisma.payment.upsert.mock.calls[0][0].create;
    expect(createData.amount).toBe(5000); // full service price, not attacker-chosen
    expect(result.payment.amount).toBe(5000);
  });

  test('replaying verify on an already-successful payment is a no-op and does not re-arm payout (V4)', async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(bookingFixture());
    mockPrisma.payment.findUnique.mockResolvedValue({
      id: 99,
      bookingId: 1,
      status: 'success',
      vendorPayoutStatus: 'settled',
      platformFee: { toString: () => '500' },
      vendorAmount: { toString: () => '4500' },
    });

    const signature = validSignature('order_2', 'pay_2');

    const result = await verifyAndRecordPayment({
      bookingId: 1,
      requestingUserId: 7,
      orderId: 'order_2',
      paymentId: 'pay_2',
      signature,
      gateway: 'razorpay',
    });

    expect(result.alreadyRecorded).toBe(true);
    // The already-settled payout status must not have been touched.
    expect(mockPrisma.payment.upsert).not.toHaveBeenCalled();
  });

  test('rejects a payment that is not actually captured at the gateway (V7)', async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(bookingFixture());
    mockPaymentsFetch.mockResolvedValue(capturedPaymentFixture({ status: 'authorized' }));
    const signature = validSignature('order_1', 'pay_1');

    await expect(
      verifyAndRecordPayment({
        bookingId: 1,
        requestingUserId: 7,
        orderId: 'order_1',
        paymentId: 'pay_1',
        signature,
        gateway: 'razorpay',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects a captured payment that belongs to a different order (V7)', async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(bookingFixture());
    mockPaymentsFetch.mockResolvedValue(capturedPaymentFixture({ order_id: 'order_other' }));
    const signature = validSignature('order_1', 'pay_1');

    await expect(
      verifyAndRecordPayment({
        bookingId: 1,
        requestingUserId: 7,
        orderId: 'order_1',
        paymentId: 'pay_1',
        signature,
        gateway: 'razorpay',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects a captured payment whose gateway amount is less than the booking price (V7/V2)', async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(bookingFixture());
    mockPaymentsFetch.mockResolvedValue(capturedPaymentFixture({ amount: 100 })); // ₹1 in paise
    const signature = validSignature('order_1', 'pay_1');

    await expect(
      verifyAndRecordPayment({
        bookingId: 1,
        requestingUserId: 7,
        orderId: 'order_1',
        paymentId: 'pay_1',
        signature,
        gateway: 'razorpay',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects verification with a missing booking', async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(null);

    await expect(
      verifyAndRecordPayment({
        bookingId: 999,
        requestingUserId: 7,
        orderId: 'order_1',
        paymentId: 'pay_1',
        signature: 'x',
        gateway: 'razorpay',
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
