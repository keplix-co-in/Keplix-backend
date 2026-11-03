import { jest } from '@jest/globals';

/**
 * refund.processed / refund.failed webhooks (2026-11-03). A known refund
 * goes through applyGatewayRefundOutcome; an unknown processed refund was
 * made in the Razorpay dashboard and gets recorded (it used to be only
 * logged, so admin never saw it and the vendor could still be paid out).
 * The customer hears about a failure once, not on every repeat or stale event.
 */

const mockPrisma = {
  webhookEvent: { create: jest.fn().mockResolvedValue({}), delete: jest.fn().mockResolvedValue({}) },
  refund: { findFirst: jest.fn() },
  payment: { findUnique: jest.fn() },
};

const mockApply = jest.fn();
const mockRecordDashboard = jest.fn();
const mockCreateNotification = jest.fn();

jest.unstable_mockModule('../../../util/webhookVerification.js', () => ({
  verifyRazorpayWebhook: jest.fn().mockReturnValue(true),
  verifyRazorpayXWebhook: jest.fn(),
}));
jest.unstable_mockModule('../../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../services/paymentService.js', () => ({
  verifyAndRecordPayment: jest.fn(),
  recordCapturedPaymentFromWebhook: jest.fn(),
  PaymentError: class PaymentError extends Error {},
}));
jest.unstable_mockModule('../../../services/refundService.js', () => ({
  applyGatewayRefundOutcome: mockApply,
  recordDashboardRefund: mockRecordDashboard,
}));
jest.unstable_mockModule('../../../util/notificationHelper.js', () => ({
  createNotification: mockCreateNotification,
}));

const { handleRazorpayWebhook } = await import('../../../controllers/user/paymentController.js');

const send = async (event, entity) => {
  const body = { event, payload: { refund: { entity } } };
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  await handleRazorpayWebhook(
    { headers: { 'x-razorpay-signature': 'sig' }, rawBody: Buffer.from(JSON.stringify(body)), body },
    res,
  );
  return res;
};

const entity = { id: 'rfnd_1', payment_id: 'pay_1', amount: 20000 };
const ORIGINAL_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.RAZORPAY_WEBHOOK_SECRET = 'a_real_secret_value';
  mockPrisma.webhookEvent.create.mockResolvedValue({});
  mockPrisma.payment.findUnique.mockResolvedValue({
    booking: { id: 7, userId: 3, service: { name: 'Car wash' } },
  });
});
afterAll(() => {
  process.env.RAZORPAY_WEBHOOK_SECRET = ORIGINAL_SECRET;
});

describe('refund.processed', () => {
  test('a known refund is confirmed through applyGatewayRefundOutcome', async () => {
    const row = { id: 10, paymentId: 1, status: 'gateway_confirmed' };
    mockPrisma.refund.findFirst.mockResolvedValue(row);
    mockApply.mockResolvedValue({ changed: true, refund: row });

    await send('refund.processed', entity);

    expect(mockApply).toHaveBeenCalledWith(row, 'processed', entity);
    expect(mockRecordDashboard).not.toHaveBeenCalled();
  });

  test('an unknown refund (made in the Razorpay dashboard) is recorded', async () => {
    mockPrisma.refund.findFirst.mockResolvedValue(null);
    mockRecordDashboard.mockResolvedValue({ refund: {}, payment: { id: 1 }, payoutAlreadySettled: false });

    const res = await send('refund.processed', entity);

    expect(mockRecordDashboard).toHaveBeenCalledWith(entity);
    expect(mockApply).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(500);
  });

  test('a processing error returns 500 and drops the dedupe row so Razorpay can retry', async () => {
    mockPrisma.refund.findFirst.mockResolvedValue(null);
    mockRecordDashboard.mockRejectedValue(new Error('db down'));

    const res = await send('refund.processed', entity);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockPrisma.webhookEvent.delete).toHaveBeenCalled();
  });
});

describe('refund.failed', () => {
  test('marks the refund failed and tells the customer once', async () => {
    const row = { id: 10, paymentId: 1, status: 'gateway_confirmed' };
    mockPrisma.refund.findFirst.mockResolvedValue(row);
    mockApply.mockResolvedValue({ changed: true, refund: row });

    await send('refund.failed', entity);

    expect(mockApply).toHaveBeenCalledWith(row, 'failed', entity);
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification.mock.calls[0][0]).toBe(3);
  });

  test('a stale failure (refund already processed) changes nothing and does not notify', async () => {
    const row = { id: 10, paymentId: 1, status: 'processed' };
    mockPrisma.refund.findFirst.mockResolvedValue(row);
    mockApply.mockResolvedValue({ changed: false, refund: row });

    await send('refund.failed', entity);

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  test('an unknown failed refund is ignored (no money moved)', async () => {
    mockPrisma.refund.findFirst.mockResolvedValue(null);

    await send('refund.failed', entity);

    expect(mockApply).not.toHaveBeenCalled();
    expect(mockRecordDashboard).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});
