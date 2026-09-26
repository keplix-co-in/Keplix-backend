/**
 * Regression test for audit #13/#58: createVendorPaymentOrder had no test
 * coverage for the price-floor/ceiling guard added in e77354c. This locks
 * that guard in -- it is the only server-side check standing between a
 * vendor's request and a live Razorpay order, since there is no
 * Subscription/Plan/Invoice model this endpoint can price itself from (see
 * the controller's own comment).
 */
import { jest } from '@jest/globals';

const mockOrdersCreate = jest.fn();

jest.unstable_mockModule('razorpay', () => ({
  default: jest.fn().mockImplementation(() => ({
    orders: { create: mockOrdersCreate },
  })),
}));

jest.unstable_mockModule('../../../util/prisma.js', () => ({
  default: {},
}));

const { createVendorPaymentOrder } = await import('../../../controllers/vendor/paymentController.js');

const mockReq = (body) => ({ body, user: { id: 42 } });
const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockOrdersCreate.mockResolvedValue({ id: 'order_test', amount: 10000, currency: 'INR' });
});

describe('createVendorPaymentOrder amount bound (audit #13/#58)', () => {
  test('rejects a missing amount', async () => {
    const res = mockRes();
    await createVendorPaymentOrder(mockReq({}), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockOrdersCreate).not.toHaveBeenCalled();
  });

  test('rejects an amount below the floor (a scripted ₹0.01 request)', async () => {
    const res = mockRes();
    await createVendorPaymentOrder(mockReq({ amount: 0.01 }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockOrdersCreate).not.toHaveBeenCalled();
  });

  test('rejects an amount above the ceiling', async () => {
    const res = mockRes();
    await createVendorPaymentOrder(mockReq({ amount: 500000 }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockOrdersCreate).not.toHaveBeenCalled();
  });

  test('rejects a non-numeric amount', async () => {
    const res = mockRes();
    await createVendorPaymentOrder(mockReq({ amount: 'free money please' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockOrdersCreate).not.toHaveBeenCalled();
  });

  test('accepts an amount within bounds and creates a Razorpay order in paise', async () => {
    const res = mockRes();
    await createVendorPaymentOrder(mockReq({ amount: 500 }), res);

    expect(mockOrdersCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 50000, currency: 'INR' }),
    );
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  test('rejects gateway: "stripe" (unsupported, stripe dependency was removed)', async () => {
    const res = mockRes();
    await createVendorPaymentOrder(mockReq({ amount: 500, gateway: 'stripe' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockOrdersCreate).not.toHaveBeenCalled();
  });
});
