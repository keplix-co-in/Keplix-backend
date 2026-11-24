/**
 * The vendor createVendorPaymentOrder 502-on-gateway-failure case was removed
 * (audit): the endpoint is retired and answers 410 USE_SUBSCRIPTIONS without
 * ever calling Razorpay. Full coverage in tests/controllers/vendor/paymentController.test.js.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: {} }));

test('vendor createVendorPaymentOrder no longer reaches the gateway: 410', async () => {
  const { createVendorPaymentOrder } = await import('../../controllers/vendor/paymentController.js');
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  await createVendorPaymentOrder({ body: { amount: 999, gateway: 'razorpay' }, user: { id: 9 } }, res);
  expect(res.status).toHaveBeenCalledWith(410);
});
