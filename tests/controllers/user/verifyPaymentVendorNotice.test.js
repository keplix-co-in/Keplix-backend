/**
 * Owner decision 2026-11-22: customers pay the garage directly, so the in-app
 * verifyPayment endpoint is retired. It answers 410 PAY_AT_GARAGE and must not
 * record a payment or notify the vendor (it used to send a neutral
 * BOOKING_READY notice, per the 2026-11-03 decision that vendors are never
 * told a customer paid through the platform).
 */
import { jest } from '@jest/globals';

const mockVerifyAndRecord = jest.fn();
const mockCreateNotification = jest.fn().mockResolvedValue({ id: 1 });

jest.unstable_mockModule('../../../util/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../../../util/notificationHelper.js', () => ({
  createNotification: mockCreateNotification,
}));
jest.unstable_mockModule('../../../services/paymentService.js', () => ({
  verifyAndRecordPayment: mockVerifyAndRecord,
  recordCapturedPaymentFromWebhook: jest.fn(),
  PaymentError: class PaymentError extends Error {},
}));

const { verifyPayment } = await import('../../../controllers/user/paymentController.js');

const emit = jest.fn();
const to = jest.fn(() => ({ emit }));
const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => jest.clearAllMocks());

describe('verifyPayment is retired (pay-the-garage)', () => {
  test('answers 410 PAY_AT_GARAGE and records nothing', async () => {
    const res = mockRes();
    await verifyPayment({
      body: { orderId: 'order_1', paymentId: 'pay_1', signature: 'sig', bookingId: 1 },
      user: { id: 7 },
      app: { get: () => ({ to }) },
    }, res);
    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PAY_AT_GARAGE' }));
    expect(mockVerifyAndRecord).not.toHaveBeenCalled();
  });

  test('never notifies the vendor or emits socket events', async () => {
    await verifyPayment({ body: {}, user: { id: 7 }, app: { get: () => ({ to }) } }, mockRes());
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(to).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
