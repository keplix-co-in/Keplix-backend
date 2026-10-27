/**
 * Regression (review fix 2026-10-24): a redelivered `payment.captured`
 * webhook must not flip a REFUNDED payment back to success.
 *
 * recordCapturedPaymentFromWebhook promoted any existing row whose status was
 * `!== 'success'` -- which includes 'refunded'. Razorpay redelivers webhooks
 * (retries, manual replays), so a refunded payment could come back as
 * 'success', re-arming the payout and auto-confirm paths for money already
 * returned to the customer. Only 'pending' and 'failed' rows are promoted
 * now, and the write is guarded on those statuses.
 *
 * Mocked Prisma, no database.
 */
import { jest } from '@jest/globals';

const mockPrisma = {
  payment: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  booking: { findUnique: jest.fn() },
};

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('razorpay', () => ({
  default: jest.fn().mockImplementation(() => ({ payments: {}, orders: {} })),
}));
jest.unstable_mockModule('../../services/refundPolicy.js', () => ({
  executeCancellationRefund: jest.fn(),
  resolveCancellationRefund: jest.fn(),
}));
jest.unstable_mockModule('../../util/notificationHelper.js', () => ({
  createNotification: jest.fn().mockResolvedValue(null),
  sendPushNotification: jest.fn().mockResolvedValue(null),
}));
jest.unstable_mockModule('../../util/platformSettings.js', () => ({
  resolvePlatformFeeRate: jest.fn().mockResolvedValue(0.1),
}));

const { recordCapturedPaymentFromWebhook } = await import('../../services/paymentService.js');

const event = { orderId: 'order_1', paymentId: 'pay_1', amountPaise: 150000, bookingIdHint: '501' };

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });
});

describe('recordCapturedPaymentFromWebhook on an existing payment row', () => {
  test('a REFUNDED payment stays refunded', async () => {
    mockPrisma.payment.findFirst.mockResolvedValue({ id: 9, status: 'refunded' });

    const result = await recordCapturedPaymentFromWebhook(event);

    expect(result).toEqual({ created: false });
    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
  });

  test('an already-successful payment is left alone (idempotent redelivery)', async () => {
    mockPrisma.payment.findFirst.mockResolvedValue({ id: 9, status: 'success' });

    await recordCapturedPaymentFromWebhook(event);

    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
  });

  test.each(['pending', 'failed'])('a %s payment is promoted to success with a guarded write', async (status) => {
    mockPrisma.payment.findFirst.mockResolvedValue({ id: 9, status });

    const result = await recordCapturedPaymentFromWebhook(event);

    expect(result).toEqual({ created: false });
    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
      // Guarded so a refund that commits between the read and this write wins.
      where: { id: 9, status: { in: ['pending', 'failed'] } },
      data: { status: 'success' },
    });
    // Existing-row path never creates a payment or touches the booking.
    expect(mockPrisma.booking.findUnique).not.toHaveBeenCalled();
  });
});
