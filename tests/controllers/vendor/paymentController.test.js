/**
 * Audit: the legacy vendor payment endpoints are retired (410 USE_SUBSCRIPTIONS).
 * They accepted a client amount and wrote Payment rows with platformFee=amount,
 * inflating revenue KPIs. Replaces the old amount-bound tests.
 */
import { jest } from '@jest/globals';

const mockOrdersCreate = jest.fn();
const mockPaymentCreate = jest.fn();
jest.unstable_mockModule('razorpay', () => ({
  default: jest.fn().mockImplementation(() => ({ orders: { create: mockOrdersCreate } })),
}));
jest.unstable_mockModule('../../../util/prisma.js', () => ({ default: { payment: { create: mockPaymentCreate } } }));

const { createVendorPaymentOrder, verifyVendorPayment } = await import('../../../controllers/vendor/paymentController.js');

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe.each([['createVendorPaymentOrder', createVendorPaymentOrder], ['verifyVendorPayment', verifyVendorPayment]])('%s', (_n, fn) => {
  test('answers 410 USE_SUBSCRIPTIONS and touches neither Razorpay nor the DB', async () => {
    const res = mockRes();
    await fn({ body: { amount: 500, gateway: 'razorpay', orderId: 'o', paymentId: 'p', signature: 's' }, user: { id: 42 } }, res);
    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.json.mock.calls[0][0]).toEqual(expect.objectContaining({ code: 'USE_SUBSCRIPTIONS' }));
    expect(mockOrdersCreate).not.toHaveBeenCalled();
    expect(mockPaymentCreate).not.toHaveBeenCalled();
  });
});
