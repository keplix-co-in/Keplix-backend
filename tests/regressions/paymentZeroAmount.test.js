/**
 * 2026-11-03 payment-502 incident: a booking whose amount resolved to 0 went
 * to Razorpay, which rejects anything under ₹1 -> opaque 502 in the app.
 * createPaymentOrder now refuses it with a 422 and never calls the gateway.
 */
import { jest } from '@jest/globals';

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const create = jest.fn();
const all = jest.fn();

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    booking: {
      findUnique: jest.fn().mockResolvedValue({
        id: 1, userId: 5, status: 'confirmed', vendor_status: 'accepted',
        service: { id: 1, price: '0.00', vendorId: 9 }, bookingVehicle: null,
      }),
    },
  },
}));
jest.unstable_mockModule('razorpay', () => ({
  default: jest.fn().mockImplementation(() => ({ orders: { all, create } })),
}));
jest.unstable_mockModule('../../util/webhookVerification.js', () => ({ verifyRazorpayWebhook: jest.fn() }));
jest.unstable_mockModule('../../util/notificationHelper.js', () => ({ createNotification: jest.fn() }));
jest.unstable_mockModule('../../util/notificationTemplates.js', () => ({ renderNotification: jest.fn(), NOTIFICATION_TYPES: {} }));
jest.unstable_mockModule('../../util/logger.js', () => ({ default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } }));
jest.unstable_mockModule('../../services/paymentService.js', () => ({
  verifyAndRecordPayment: jest.fn(), recordCapturedPaymentFromWebhook: jest.fn(), PaymentError: class extends Error {},
}));
const resolveBookingAmount = jest.fn();
jest.unstable_mockModule('../../util/servicePricing.js', () => ({ resolveBookingAmount }));

const { createPaymentOrder } = await import('../../controllers/user/paymentController.js');

describe('createPaymentOrder — amount under ₹1 is refused before the gateway', () => {
  beforeEach(() => { create.mockReset(); all.mockReset(); jest.spyOn(console, 'error').mockImplementation(() => {}); });

  test.each([0, 0.5, NaN, null])('amount %p -> 422 INVALID_BOOKING_AMOUNT, no Razorpay call', async (amount) => {
    resolveBookingAmount.mockReturnValue(amount);
    const res = mockRes();
    await createPaymentOrder({ body: { bookingId: 1 }, user: { id: 5 } }, res);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_BOOKING_AMOUNT' }));
    expect(create).not.toHaveBeenCalled();
  });

  test('₹1 exactly still goes to the gateway', async () => {
    resolveBookingAmount.mockReturnValue(1);
    all.mockResolvedValue({ items: [] });
    create.mockResolvedValue({ id: 'order_1', amount: 100, currency: 'INR' });
    const res = mockRes();
    await createPaymentOrder({ body: { bookingId: 1 }, user: { id: 5 } }, res);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ amount: 100 }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'order_1' }));
  });
});
