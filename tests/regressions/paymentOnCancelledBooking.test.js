/**
 * Regression: a captured payment must never revive (or roll back) a booking.
 *
 * recordSuccessfulPayment used to move the booking to `confirmed` with an
 * unconditional update. A capture that landed after the booking had been
 * cancelled (a payment tab left open, a late webhook) brought the cancelled
 * booking straight back to life, and a payment on an in_progress booking
 * rolled it back to confirmed. The write is now a guarded updateMany, and a
 * payment for a cancelled booking is refunded in full (forceFullRefund).
 *
 * createPaymentOrder also refuses (409 BOOKING_NOT_PAYABLE) to open an order
 * for a booking the vendor has not accepted or that is no longer live.
 *
 * Mocked Prisma, no database.
 */
import { jest } from '@jest/globals';
import crypto from 'node:crypto';

const txBooking = {
  updateMany: jest.fn(),
  findUnique: jest.fn(),
};
const txPaymentUpsert = jest.fn();

const mockPrisma = {
  booking: { findUnique: jest.fn() },
  payment: { findUnique: jest.fn() },
  $transaction: jest.fn(async (cb) =>
    cb({
      $queryRaw: jest.fn().mockResolvedValue([]),
      payment: { upsert: txPaymentUpsert },
      booking: txBooking,
    }),
  ),
};

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));

const mockPaymentsFetch = jest.fn();
const mockOrdersCreate = jest.fn();
jest.unstable_mockModule('razorpay', () => ({
  default: jest.fn().mockImplementation(() => ({
    payments: { fetch: mockPaymentsFetch },
    orders: { create: mockOrdersCreate, all: jest.fn().mockResolvedValue({ items: [] }) },
  })),
}));

jest.unstable_mockModule('../../services/refundPolicy.js', () => ({
  executeCancellationRefund: jest.fn(),
  resolveCancellationRefund: jest.fn(),
}));
jest.unstable_mockModule('../../util/notificationHelper.js', () => ({
  createNotification: jest.fn().mockResolvedValue(null),
  sendPushNotification: jest.fn().mockResolvedValue(null),
}));
jest.unstable_mockModule('../../util/platformSettings.js', () => ({
  resolvePlatformFeeRate: jest.fn().mockResolvedValue(0.1),
}));

const { verifyAndRecordPayment } = await import('../../services/paymentService.js');
const { createPaymentOrder } = await import('../../controllers/user/paymentController.js');
const { executeCancellationRefund } = await import('../../services/refundPolicy.js');
const { createNotification } = await import('../../util/notificationHelper.js');

const SECRET = 'test_secret_regression';
const USER_ID = 7;
const BOOKING_ID = 41;

const bookingRow = (overrides = {}) => ({
  id: BOOKING_ID,
  userId: USER_ID,
  status: 'cancelled',
  vendor_status: 'accepted',
  service: { id: 1, price: { toString: () => '5000' }, vendorId: 42 },
  ...overrides,
});

const sign = (orderId, paymentId) =>
  crypto.createHmac('sha256', SECRET).update(orderId + '|' + paymentId).digest('hex');

const verifyArgs = () => ({
  bookingId: BOOKING_ID,
  requestingUserId: USER_ID,
  orderId: 'order_1',
  paymentId: 'pay_1',
  signature: sign('order_1', 'pay_1'),
  gateway: 'razorpay',
});

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

let warnSpy;
let errorSpy;
beforeAll(() => {
  process.env.RAZORPAY_KEY_SECRET = SECRET;
});

beforeEach(() => {
  jest.clearAllMocks();
  // The service logs [ADMIN NOTICE] / [MANUAL ACTION] lines; keep the run quiet.
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  mockPrisma.payment.findUnique.mockResolvedValue(null);
  mockPaymentsFetch.mockResolvedValue({ id: 'pay_1', order_id: 'order_1', status: 'captured', amount: 500000 });
  txPaymentUpsert.mockResolvedValue({ id: 900, bookingId: BOOKING_ID, status: 'success', amount: 5000 });
});

afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('a payment captured for an already-cancelled booking', () => {
  beforeEach(() => {
    mockPrisma.booking.findUnique.mockResolvedValue(bookingRow());
    // Guarded write matches nothing: the booking is cancelled.
    txBooking.updateMany.mockResolvedValue({ count: 0 });
    txBooking.findUnique.mockResolvedValue(bookingRow());
  });

  test('does not revive the booking and issues a forced full refund', async () => {
    executeCancellationRefund.mockResolvedValue({ refunded: true, amount: 5000, payoutAlreadySettled: false });

    const result = await verifyAndRecordPayment(verifyArgs());

    // The only booking write is the guarded one, and its WHERE excludes cancelled.
    expect(txBooking.updateMany).toHaveBeenCalledWith({
      where: { id: BOOKING_ID, status: { in: ['pending', 'confirmed'] }, vendor_status: 'accepted' },
      data: { status: 'confirmed' },
    });
    expect(txBooking.update).toBeUndefined();

    expect(executeCancellationRefund).toHaveBeenCalledTimes(1);
    expect(executeCancellationRefund).toHaveBeenCalledWith(
      expect.objectContaining({ forceFullRefund: true, payment: expect.objectContaining({ id: 900 }) }),
    );
    expect(result.bookingActive).toBe(false);
    expect(result.updatedBooking.status).toBe('cancelled');
    expect(result.refundOutcome).toEqual(expect.objectContaining({ refunded: true }));

    // The customer is told the money is coming back.
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
    );
  });

  test('a refund that cannot be issued automatically is logged for manual action, not thrown', async () => {
    executeCancellationRefund.mockResolvedValue({ refunded: false, code: 'GATEWAY_ERROR', reason: 'down' });

    const result = await verifyAndRecordPayment(verifyArgs());

    expect(result.bookingActive).toBe(false);
    expect(createNotification).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[MANUAL ACTION]'));
  });
});

test('a payment on an in_progress booking leaves it in_progress (no rollback) and refunds nothing', async () => {
  mockPrisma.booking.findUnique.mockResolvedValue(bookingRow({ status: 'in_progress' }));
  txBooking.updateMany.mockResolvedValue({ count: 0 });
  txBooking.findUnique.mockResolvedValue(bookingRow({ status: 'in_progress' }));

  const result = await verifyAndRecordPayment(verifyArgs());

  expect(result.bookingActive).toBe(true);
  expect(result.updatedBooking.status).toBe('in_progress');
  expect(executeCancellationRefund).not.toHaveBeenCalled();
});

describe('createPaymentOrder refuses a booking that cannot be paid for', () => {
  const req = () => ({ body: { bookingId: String(BOOKING_ID) }, user: { id: USER_ID } });

  test.each([
    ['cancelled', 'accepted'],
    ['pending', 'pending'],
    ['pending', 'rejected'],
    ['user_confirmed', 'accepted'],
  ])('status %s / vendor_status %s -> 409 BOOKING_NOT_PAYABLE', async (status, vendor_status) => {
    mockPrisma.booking.findUnique.mockResolvedValue(bookingRow({ status, vendor_status }));
    const res = mockRes();

    await createPaymentOrder(req(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'BOOKING_NOT_PAYABLE' }));
    expect(mockOrdersCreate).not.toHaveBeenCalled();
  });

  test('a non-numeric booking id is 400 before any lookup', async () => {
    const res = mockRes();
    await createPaymentOrder({ body: { bookingId: 'abc' }, user: { id: USER_ID } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.booking.findUnique).not.toHaveBeenCalled();
  });
});
