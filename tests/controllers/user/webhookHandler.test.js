/**
 * Regression test for audit #14: handleRazorpayWebhook's unconfigured-secret
 * guard and its call into signature verification had zero test coverage.
 * Signature verification itself is covered in
 * tests/util/webhookVerification.test.js; this covers the handler's own
 * guards that sit in front of it.
 */
import { jest } from '@jest/globals';

const mockVerify = jest.fn();

jest.unstable_mockModule('../../../util/webhookVerification.js', () => ({
  verifyRazorpayWebhook: mockVerify,
  verifyRazorpayXWebhook: jest.fn(),
}));

jest.unstable_mockModule('../../../util/prisma.js', () => ({
  default: {
    webhookEvent: { create: jest.fn() },
  },
}));

jest.unstable_mockModule('../../../services/paymentService.js', () => ({
  verifyAndRecordPayment: jest.fn(),
  recordCapturedPaymentFromWebhook: jest.fn(),
  PaymentError: class PaymentError extends Error {},
}));

const prisma = (await import('../../../util/prisma.js')).default;
const { handleRazorpayWebhook } = await import('../../../controllers/user/paymentController.js');

const mockReq = (body = { event: 'order.paid', payload: { order: { entity: { id: 'order_1' } } } }) => ({
  headers: { 'x-razorpay-signature': 'sig' },
  rawBody: Buffer.from(JSON.stringify(body)),
  body,
});

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const ORIGINAL_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

afterEach(() => {
  process.env.RAZORPAY_WEBHOOK_SECRET = ORIGINAL_SECRET;
  jest.clearAllMocks();
});

describe('handleRazorpayWebhook - unconfigured-secret guard', () => {
  test('500s when RAZORPAY_WEBHOOK_SECRET is unset', async () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    const res = mockRes();

    await handleRazorpayWebhook(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  // The .env.example placeholder is a truthy string, so a naive `!secret`
  // check alone would silently accept it and verify every webhook against a
  // value nobody else can produce a valid HMAC for -- every real webhook
  // would then fail signature verification forever, indistinguishable from
  // an actual attack.
  test('500s when RAZORPAY_WEBHOOK_SECRET is still the .env.example placeholder', async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = 'your_razorpay_webhook_secret_here';
    const res = mockRes();

    await handleRazorpayWebhook(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockVerify).not.toHaveBeenCalled();
  });
});

describe('handleRazorpayWebhook - signature check', () => {
  beforeEach(() => {
    process.env.RAZORPAY_WEBHOOK_SECRET = 'a_real_secret_value';
  });

  test('400s when the signature does not verify', async () => {
    mockVerify.mockReturnValue(false);
    const res = mockRes();

    await handleRazorpayWebhook(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  test('proceeds to dedupe once the signature verifies', async () => {
    mockVerify.mockReturnValue(true);
    prisma.webhookEvent.create.mockResolvedValue({});
    const res = mockRes();

    await handleRazorpayWebhook(mockReq(), res);

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(prisma.webhookEvent.create).toHaveBeenCalled();
  });

  test('a duplicate delivery (P2002 on the dedupe row) is acknowledged, not reprocessed', async () => {
    mockVerify.mockReturnValue(true);
    const dupeErr = new Error('unique constraint');
    dupeErr.code = 'P2002';
    prisma.webhookEvent.create.mockRejectedValue(dupeErr);
    const res = mockRes();

    await handleRazorpayWebhook(mockReq(), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ duplicate: true }));
  });
});
