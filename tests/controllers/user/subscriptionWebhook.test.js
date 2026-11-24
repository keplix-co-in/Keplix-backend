/**
 * Webhook branch for garage subscription orders (owner decision 2026-11-22:
 * the gateway is used only for subscriptions). payment.captured / order.paid
 * whose notes say type 'subscription' settle the subscription; an order we
 * have no SubscriptionPayment row for falls through to the old booking path so
 * no money goes unrecorded; the retired customer endpoints answer 410.
 */
import { jest } from '@jest/globals';

const mockVerify = jest.fn().mockReturnValue(true);
jest.unstable_mockModule('../../../util/webhookVerification.js', () => ({
  verifyRazorpayWebhook: mockVerify,
  verifyRazorpayXWebhook: jest.fn(),
}));
jest.unstable_mockModule('../../../util/prisma.js', () => ({
  default: { webhookEvent: { create: jest.fn().mockResolvedValue({}), delete: jest.fn().mockResolvedValue({}) }, payment: { findFirst: jest.fn() } },
}));
const recordCaptured = jest.fn();
jest.unstable_mockModule('../../../services/paymentService.js', () => ({
  verifyAndRecordPayment: jest.fn(),
  recordCapturedPaymentFromWebhook: recordCaptured,
  PaymentError: class PaymentError extends Error {},
}));
const handleSubscriptionCaptured = jest.fn();
const handleSubscriptionFailed = jest.fn();
jest.unstable_mockModule('../../../services/subscriptionService.js', () => ({
  handleSubscriptionCaptured,
  handleSubscriptionFailed,
  isSubscriptionNotes: (n) => n?.type === 'subscription',
}));

const prisma = (await import('../../../util/prisma.js')).default;
const pc = await import('../../../controllers/user/paymentController.js');

process.env.RAZORPAY_WEBHOOK_SECRET = 'a_real_secret_value';

const req = (body) => ({ headers: { 'x-razorpay-signature': 'sig', 'x-razorpay-event-id': `evt_${Math.random()}` }, rawBody: Buffer.from(JSON.stringify(body)), body });
const mockRes = () => { const r = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r; };
const captured = (notes) => ({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 99900, notes } } } });

beforeEach(() => {
  jest.clearAllMocks();
  mockVerify.mockReturnValue(true);
  prisma.webhookEvent.create.mockResolvedValue({});
});

describe('payment.captured', () => {
  test('a subscription order settles the subscription and never touches the booking path', async () => {
    handleSubscriptionCaptured.mockResolvedValue({ applied: true });
    const res = mockRes();
    await pc.handleRazorpayWebhook(req(captured({ type: 'subscription', vendorId: '5' })), res);
    expect(handleSubscriptionCaptured).toHaveBeenCalledWith({ orderId: 'order_1', paymentId: 'pay_1', amountPaise: 99900 });
    expect(recordCaptured).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(500);
  });

  test('a replayed subscription capture is a quiet no-op (idempotent)', async () => {
    handleSubscriptionCaptured.mockResolvedValue({ applied: false });
    const res = mockRes();
    await pc.handleRazorpayWebhook(req(captured({ type: 'subscription' })), res);
    expect(recordCaptured).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(500);
  });

  test('a mismatched subscription amount is flagged and does NOT fall through to the booking path', async () => {
    handleSubscriptionCaptured.mockResolvedValue({ mismatch: true });
    await pc.handleRazorpayWebhook(req(captured({ type: 'subscription' })), mockRes());
    expect(recordCaptured).not.toHaveBeenCalled();
  });

  test('subscription notes but no row of ours (unresolved): falls through so an old booking order is still recorded', async () => {
    handleSubscriptionCaptured.mockResolvedValue({ unresolved: true });
    recordCaptured.mockResolvedValue({ created: true });
    await pc.handleRazorpayWebhook(req(captured({ type: 'subscription', bookingId: '9' })), mockRes());
    expect(recordCaptured).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'order_1', paymentId: 'pay_1' }));
  });

  test('a booking order (no subscription notes) still goes to the booking path', async () => {
    recordCaptured.mockResolvedValue({});
    await pc.handleRazorpayWebhook(req(captured({ bookingId: '9' })), mockRes());
    expect(handleSubscriptionCaptured).not.toHaveBeenCalled();
    expect(recordCaptured).toHaveBeenCalled();
  });

  test('a processing error rolls back the dedupe row and answers 500 so Razorpay retries', async () => {
    handleSubscriptionCaptured.mockRejectedValue(new Error('db down'));
    const res = mockRes();
    await pc.handleRazorpayWebhook(req(captured({ type: 'subscription' })), res);
    expect(prisma.webhookEvent.delete).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('order.paid', () => {
  const orderPaid = (notes) => ({ event: 'order.paid', payload: { order: { entity: { id: 'order_1', notes } }, payment: { entity: { id: 'pay_1', amount: 99900 } } } });
  test('a subscription order is settled from order.paid too', async () => {
    handleSubscriptionCaptured.mockResolvedValue({ applied: true });
    await pc.handleRazorpayWebhook(req(orderPaid({ type: 'subscription' })), mockRes());
    expect(handleSubscriptionCaptured).toHaveBeenCalledWith({ orderId: 'order_1', paymentId: 'pay_1', amountPaise: 99900 });
  });

  test('a non-subscription order.paid does nothing', async () => {
    await pc.handleRazorpayWebhook(req(orderPaid({ bookingId: '1' })), mockRes());
    expect(handleSubscriptionCaptured).not.toHaveBeenCalled();
  });
});

describe('payment.failed', () => {
  test('a failed subscription payment flips its row to failed', async () => {
    prisma.payment.findFirst.mockResolvedValue(null);
    const body = { event: 'payment.failed', payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', notes: { type: 'subscription' }, error_description: 'declined' } } } };
    await pc.handleRazorpayWebhook(req(body), mockRes());
    expect(handleSubscriptionFailed).toHaveBeenCalledWith({ orderId: 'order_1' });
  });
});

describe('retired customer endpoints', () => {
  test.each(['createPaymentOrder', 'getPaymentQuote', 'verifyPayment'])('%s answers 410 PAY_AT_GARAGE', async (name) => {
    const res = mockRes();
    await pc[name]({ body: {}, params: {}, user: { id: 1 } }, res);
    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'PAY_AT_GARAGE', error: expect.objectContaining({ code: 'PAY_AT_GARAGE' }) }));
  });
});
