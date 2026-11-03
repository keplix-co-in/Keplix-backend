/**
 * Owner decision 2026-11-03: the vendor must not be told a customer paid.
 * verifyPayment used to send PAYMENT_RECEIVED ("A customer has paid...") and
 * a "payment_received" socket event carrying the amount. It now sends one
 * neutral BOOKING_READY notice and a plain "booking_updated" refresh, only the
 * first time a payment is recorded.
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
const mockReq = () => ({
  body: { orderId: 'order_1', paymentId: 'pay_1', signature: 'sig', bookingId: 1, gateway: 'razorpay' },
  user: { id: 7 },
  app: { get: () => ({ to }) },
});
const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const recorded = (overrides = {}) => ({
  payment: { id: 99, amount: 1000 },
  updatedBooking: { id: 1, status: 'confirmed', service: { name: 'Oil change', vendorId: 42 } },
  platformFee: 100,
  vendorAmount: 900,
  bookingActive: true,
  ...overrides,
});

beforeEach(() => jest.clearAllMocks());

describe('verifyPayment — vendor is not told about the payment', () => {
  test('sends a neutral BOOKING_READY notice with no payment or amount wording', async () => {
    mockVerifyAndRecord.mockResolvedValue(recorded());
    const res = mockRes();
    await verifyPayment(mockReq(), res);

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    const [userId, title, body, meta] = mockCreateNotification.mock.calls[0];
    expect(userId).toBe(42);
    expect(meta.type).toBe('BOOKING_READY');
    expect(meta.type).not.toBe('PAYMENT_RECEIVED');
    const wording = `${title} ${body}`.toLowerCase();
    expect(wording).not.toMatch(/pa(id|y)|₹|amount|money/);
    expect(body).toContain('Oil change');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  test('emits booking_updated with no amount, and never payment_received', async () => {
    mockVerifyAndRecord.mockResolvedValue(recorded());
    await verifyPayment(mockReq(), mockRes());

    expect(to).toHaveBeenCalledWith('user_42');
    const events = emit.mock.calls.map(([name]) => name);
    expect(events).toEqual(['booking_updated']);
    expect(emit.mock.calls[0][1]).toEqual({ bookingId: 1, status: 'confirmed' });
  });

  test('a replayed verify does not notify the vendor again', async () => {
    mockVerifyAndRecord.mockResolvedValue(recorded({ alreadyRecorded: true }));
    const res = mockRes();
    await verifyPayment(mockReq(), res);

    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  test('a booking cancelled before payment arrived notifies nobody', async () => {
    mockVerifyAndRecord.mockResolvedValue(recorded({ bookingActive: false, refundOutcome: { refunded: true } }));
    const res = mockRes();
    await verifyPayment(mockReq(), res);

    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ bookingActive: false, refundInitiated: true }));
  });
});
