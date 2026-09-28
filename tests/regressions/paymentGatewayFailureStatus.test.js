/**
 * Regression test for a bug found by the 2026-09-28 Payments module audit.
 *
 * Both createPaymentOrder (controllers/user/paymentController.js) and
 * createVendorPaymentOrder (controllers/vendor/paymentController.js) create a
 * Razorpay order via the SDK, which throws a plain `{ statusCode, error: {
 * description } }` object -- not an Error -- for anything the gateway itself
 * rejects (bad/test credentials give a 401 "Authentication failed", for
 * instance). Both controllers' catch blocks previously treated every error
 * the same way: a bare `res.status(500).json({ message: ..., error:
 * error.message })`. Since the thrown object has no `.message`, the client
 * got `{ error: undefined }` and a 500 that looks like an application bug,
 * when the actual cause is the gateway rejecting the request -- an upstream
 * failure, not ours.
 *
 * Fix: both catch blocks now check for the SDK's `error.statusCode` shape and
 * respond 502 with the gateway's own description.
 */
import { jest } from '@jest/globals';

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('payment order creation — gateway failures surface as 502, not 500 (regression)', () => {
  test('user createPaymentOrder: Razorpay auth failure -> 502 with gateway description', async () => {
    const gatewayError = { statusCode: 401, error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } };

    jest.unstable_mockModule('../../util/prisma.js', () => ({
      default: {
        booking: {
          findUnique: jest.fn().mockResolvedValue({
            id: 1,
            userId: 5,
            service: { id: 1, price: '799.00', vendorId: 9 },
            bookingVehicle: null,
          }),
        },
      },
    }));
    jest.unstable_mockModule('razorpay', () => ({
      default: jest.fn().mockImplementation(() => ({
        orders: {
          all: jest.fn().mockRejectedValue(new Error('lookup unrelated failure')),
          create: jest.fn().mockRejectedValue(gatewayError),
        },
      })),
    }));
    jest.unstable_mockModule('../../util/webhookVerification.js', () => ({ verifyRazorpayWebhook: jest.fn() }));
    jest.unstable_mockModule('../../util/notificationHelper.js', () => ({ createNotification: jest.fn() }));
    jest.unstable_mockModule('../../util/notificationTemplates.js', () => ({
      renderNotification: jest.fn(), NOTIFICATION_TYPES: {},
    }));
    jest.unstable_mockModule('../../util/logger.js', () => ({
      default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
    }));
    jest.unstable_mockModule('../../services/paymentService.js', () => ({
      verifyAndRecordPayment: jest.fn(), recordCapturedPaymentFromWebhook: jest.fn(), PaymentError: class extends Error {},
    }));
    jest.unstable_mockModule('../../util/servicePricing.js', () => ({
      resolveBookingAmount: jest.fn().mockReturnValue(799),
    }));

    const { createPaymentOrder } = await import('../../controllers/user/paymentController.js');

    const req = { body: { bookingId: 1 }, user: { id: 5 } };
    const res = mockRes();

    await createPaymentOrder(req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Authentication failed' })
    );
    expect(res.status).not.toHaveBeenCalledWith(500);
  });

  test('vendor createVendorPaymentOrder: Razorpay auth failure -> 502 with gateway description', async () => {
    const gatewayError = { statusCode: 401, error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } };

    jest.unstable_mockModule('../../util/prisma.js', () => ({ default: {} }));
    jest.unstable_mockModule('razorpay', () => ({
      default: jest.fn().mockImplementation(() => ({
        orders: { create: jest.fn().mockRejectedValue(gatewayError) },
      })),
    }));

    const { createVendorPaymentOrder } = await import('../../controllers/vendor/paymentController.js');

    const req = { body: { amount: 999, gateway: 'razorpay' }, user: { id: 9 } };
    const res = mockRes();

    await createVendorPaymentOrder(req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Authentication failed' })
    );
    expect(res.status).not.toHaveBeenCalledWith(500);
  });
});
