/**
 * Regression test for the CONFIRMED webhook dedupe-vs-processing ordering
 * defect, found by the 2026-09-12 codebase audit (code-reviewer F9).
 *
 * `handleRazorpayWebhook` committed the `WebhookEvent` dedupe row BEFORE
 * running the event's actual processing (`handlePaymentCaptured` etc). If
 * processing then threw -- a transient DB error, an unresolvable booking
 * match, anything -- the dedupe row was already permanent. Razorpay retries
 * on a non-2xx response, but the retry's identical eventId collided with the
 * UNIQUE constraint on the now-orphaned dedupe row and was silently dropped
 * as `{ duplicate: true }` -- permanently losing a captured payment with no
 * further retry ever reaching the actual processing code.
 *
 * The fix: a processing error now deletes the just-created dedupe row before
 * the 500 is returned, so Razorpay's retry is treated as a fresh delivery
 * and can actually reach `handlePaymentCaptured` this time.
 *
 * See tests/regressions/bookingStatusGuards.test.js for the file convention.
 */
import { jest } from '@jest/globals';

const mockPrisma = {
  webhookEvent: {
    create: jest.fn(),
    delete: jest.fn(),
  },
};

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('razorpay', () => ({
  default: jest.fn().mockImplementation(() => ({ payments: { fetch: jest.fn() } })),
}));
jest.unstable_mockModule('../../util/webhookVerification.js', () => ({
  verifyRazorpayWebhook: jest.fn().mockReturnValue(true),
}));
jest.unstable_mockModule('../../util/notificationHelper.js', () => ({
  createNotification: jest.fn(),
}));
jest.unstable_mockModule('../../util/notificationTemplates.js', () => ({
  renderNotification: jest.fn(),
  NOTIFICATION_TYPES: {},
}));
jest.unstable_mockModule('../../util/logger.js', () => ({
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));
jest.unstable_mockModule('../../util/servicePricing.js', () => ({
  resolveBookingAmount: jest.fn(),
}));

const recordCapturedPaymentFromWebhook = jest.fn();
jest.unstable_mockModule('../../services/paymentService.js', () => ({
  verifyAndRecordPayment: jest.fn(),
  recordCapturedPaymentFromWebhook,
  PaymentError: class PaymentError extends Error {},
}));

process.env.RAZORPAY_WEBHOOK_SECRET = 'a_real_configured_secret';

const { handleRazorpayWebhook } = await import('../../controllers/user/paymentController.js');

const mockReq = (overrides = {}) => ({
  headers: { 'x-razorpay-event-id': 'evt_test_123' },
  body: {
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 50000, notes: {} } } },
  },
  ...overrides,
});
const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.webhookEvent.create.mockResolvedValue({ id: 1, eventId: 'evt_test_123' });
  mockPrisma.webhookEvent.delete.mockResolvedValue({});
});

describe('webhook dedupe rollback on processing failure — FIXED, regression guard', () => {
  test('a processing error deletes the just-created dedupe row before responding 500', async () => {
    recordCapturedPaymentFromWebhook.mockRejectedValue(new Error('transient DB error'));

    const req = mockReq();
    const res = mockRes();

    await handleRazorpayWebhook(req, res);

    expect(mockPrisma.webhookEvent.create).toHaveBeenCalledWith({
      data: { eventId: 'evt_test_123', eventType: 'payment.captured' },
    });
    expect(mockPrisma.webhookEvent.delete).toHaveBeenCalledWith({
      where: { eventId: 'evt_test_123' },
    });
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('a retry after the rollback is treated as a fresh delivery, not a duplicate', async () => {
    // First delivery: processing fails, dedupe row is rolled back (asserted above).
    recordCapturedPaymentFromWebhook.mockRejectedValueOnce(new Error('transient DB error'));
    await handleRazorpayWebhook(mockReq(), mockRes());
    expect(mockPrisma.webhookEvent.delete).toHaveBeenCalledTimes(1);

    // Retry: create() is called again with the same eventId. Since the row was
    // rolled back, this is NOT a P2002 collision -- it succeeds, and processing
    // actually runs this time.
    jest.clearAllMocks();
    mockPrisma.webhookEvent.create.mockResolvedValue({ id: 2, eventId: 'evt_test_123' });
    recordCapturedPaymentFromWebhook.mockResolvedValueOnce({ created: true });

    const res2 = mockRes();
    await handleRazorpayWebhook(mockReq(), res2);

    expect(recordCapturedPaymentFromWebhook).toHaveBeenCalledTimes(1);
    expect(mockPrisma.webhookEvent.delete).not.toHaveBeenCalled();
    expect(res2.json).toHaveBeenCalledWith({ received: true });
  });

  test('sanity check: successful processing never touches delete, and responds 200', async () => {
    recordCapturedPaymentFromWebhook.mockResolvedValue({ created: true });

    const res = mockRes();
    await handleRazorpayWebhook(mockReq(), res);

    expect(mockPrisma.webhookEvent.delete).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  test('sanity check: a genuine duplicate delivery (P2002 on create) is still short-circuited before processing', async () => {
    mockPrisma.webhookEvent.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    );

    const res = mockRes();
    await handleRazorpayWebhook(mockReq(), res);

    expect(recordCapturedPaymentFromWebhook).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true, duplicate: true });
  });
});
