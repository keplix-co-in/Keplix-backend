import { jest } from '@jest/globals';
import crypto from 'node:crypto';

// Fee ON TOP (owner decision 2026-11-06): order charges price + fee with the
// rate frozen in the order notes; verify/webhook take the expected amount from
// those notes, while legacy (pre-switch) orders still verify the old way.

const settings = { current: { isPlatformFeeEnabled: true, platformFeePercentage: 0.1 } };
const txBooking = {
  updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  findUnique: jest.fn().mockResolvedValue({ id: 1, status: 'confirmed', vendor_status: 'accepted', service: { vendorId: 42 } }),
};
const mockPrisma = {
  booking: { findUnique: jest.fn() },
  payment: { findUnique: jest.fn(), findFirst: jest.fn(), upsert: jest.fn() },
  platformSettings: { findFirst: jest.fn(async () => settings.current) },
  $transaction: jest.fn(async (cb) => cb({
    $queryRaw: jest.fn().mockResolvedValue([]),
    payment: { upsert: mockPrisma.payment.upsert },
    booking: txBooking,
  })),
};
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));

const rz = {
  orders: { all: jest.fn(), create: jest.fn(), fetch: jest.fn() },
  payments: { fetch: jest.fn() },
};
jest.unstable_mockModule('razorpay', () => ({ default: jest.fn().mockImplementation(() => rz) }));
jest.unstable_mockModule('../../util/notificationHelper.js', () => ({ createNotification: jest.fn() }));
jest.unstable_mockModule('../../util/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { createPaymentOrder, getPaymentQuote } = await import('../../controllers/user/paymentController.js');
const { verifyAndRecordPayment, recordCapturedPaymentFromWebhook } = await import('../../services/paymentService.js');

const SECRET = 'fee_test_secret';
const sig = (o, p) => crypto.createHmac('sha256', SECRET).update(`${o}|${p}`).digest('hex');
const bookingFixture = (o = {}) => ({
  id: 1, userId: 7, status: 'confirmed', vendor_status: 'accepted',
  service: { id: 1, price: { toString: () => '1000' }, vendorId: 42 }, bookingVehicle: null, ...o,
});
const res = () => { const r = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r; };
const onTopNotes = { bookingId: '1', servicePrice: '1000.00', platformFee: '100.00', feeRate: '0.1', feeModel: 'on_top' };

beforeAll(() => { process.env.RAZORPAY_KEY_SECRET = SECRET; });
beforeEach(() => {
  jest.clearAllMocks();
  settings.current = { isPlatformFeeEnabled: true, platformFeePercentage: 0.1 };
  mockPrisma.booking.findUnique.mockResolvedValue(bookingFixture());
  mockPrisma.payment.findUnique.mockResolvedValue(null);
  mockPrisma.payment.findFirst.mockResolvedValue(null);
  mockPrisma.payment.upsert.mockImplementation(async ({ create }) => ({ id: 99, ...create }));
  rz.orders.all.mockResolvedValue({ items: [] });
  rz.orders.create.mockImplementation(async (p) => ({ id: 'order_new', ...p }));
});

describe('createPaymentOrder — fee on top', () => {
  test('charges price + fee and freezes the split in the notes', async () => {
    const r = res();
    await createPaymentOrder({ body: { bookingId: 1 }, user: { id: 7 } }, r);
    expect(rz.orders.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 110000, notes: onTopNotes }));
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ amount: 110000, servicePrice: 1000, platformFee: 100 }));
  });

  test('fee disabled: charges the price only', async () => {
    settings.current = { isPlatformFeeEnabled: false };
    const r = res();
    await createPaymentOrder({ body: { bookingId: 1 }, user: { id: 7 } }, r);
    expect(rz.orders.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 100000 }));
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ platformFee: 0 }));
  });

  test('does not reuse a legacy (no feeModel) order even if the amount matches', async () => {
    settings.current = { isPlatformFeeEnabled: false };
    rz.orders.all.mockResolvedValue({ items: [{ id: 'order_old', status: 'created', amount: 100000, notes: { bookingId: '1' } }] });
    await createPaymentOrder({ body: { bookingId: 1 }, user: { id: 7 } }, res());
    expect(rz.orders.create).toHaveBeenCalled();
  });

  test('reuses a matching on-top order', async () => {
    rz.orders.all.mockResolvedValue({ items: [{ id: 'order_x', status: 'created', amount: 110000, currency: 'INR', notes: onTopNotes }] });
    const r = res();
    await createPaymentOrder({ body: { bookingId: 1 }, user: { id: 7 } }, r);
    expect(rz.orders.create).not.toHaveBeenCalled();
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ id: 'order_x', amount: 110000 }));
  });
});

describe('getPaymentQuote', () => {
  test('owner gets the breakdown in rupees', async () => {
    const r = res();
    await getPaymentQuote({ params: { bookingId: '1' }, user: { id: 7 } }, r);
    expect(r.json).toHaveBeenCalledWith({ success: true, data: { servicePrice: 1000, platformFee: 100, feeRate: 0.1, total: 1100 } });
  });
  test('another user is refused (403)', async () => {
    const r = res();
    await getPaymentQuote({ params: { bookingId: '1' }, user: { id: 8 } }, r);
    expect(r.status).toHaveBeenCalledWith(403);
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });
  test('bad id 400, missing booking 404', async () => {
    const r1 = res();
    await getPaymentQuote({ params: { bookingId: 'abc' }, user: { id: 7 } }, r1);
    expect(r1.status).toHaveBeenCalledWith(400);
    mockPrisma.booking.findUnique.mockResolvedValue(null);
    const r2 = res();
    await getPaymentQuote({ params: { bookingId: '1' }, user: { id: 7 } }, r2);
    expect(r2.status).toHaveBeenCalledWith(404);
  });
  test('route is mounted behind protect', async () => {
    const router = (await import('../../routes/user/payments.js')).default;
    const layer = router.stack.find((l) => l.route?.path === '/payments/quote/:bookingId');
    expect(layer.route.methods.get).toBe(true);
    const { protect } = await import('../../middleware/authMiddleware.js');
    expect(layer.route.stack[0].handle).toBe(protect);
  });
});

describe('verifyAndRecordPayment — on_top vs legacy', () => {
  const verify = () => verifyAndRecordPayment({
    bookingId: 1, requestingUserId: 7, orderId: 'order_1', paymentId: 'pay_1', signature: sig('order_1', 'pay_1'),
  });

  test('on_top: expects price + fee and records vendor = full price', async () => {
    rz.payments.fetch.mockResolvedValue({ id: 'pay_1', order_id: 'order_1', status: 'captured', amount: 110000, notes: {} });
    rz.orders.fetch.mockResolvedValue({ id: 'order_1', notes: onTopNotes });
    const out = await verify();
    expect(out.platformFee).toBe(100);
    expect(out.vendorAmount).toBe(1000);
    expect(mockPrisma.payment.upsert.mock.calls[0][0].create).toMatchObject({
      amount: 1100, platformFee: 100, vendorAmount: 1000, feeModel: 'on_top',
    });
  });

  test('on_top: admin raises the rate between order and verify -> frozen fee still used', async () => {
    settings.current = { isPlatformFeeEnabled: true, platformFeePercentage: 0.3 };
    rz.payments.fetch.mockResolvedValue({ id: 'pay_1', order_id: 'order_1', status: 'captured', amount: 110000 });
    rz.orders.fetch.mockResolvedValue({ id: 'order_1', notes: onTopNotes });
    const out = await verify();
    expect(out.platformFee).toBe(100);
    expect(mockPrisma.payment.upsert.mock.calls[0][0].create.amount).toBe(1100);
  });

  test('legacy in-flight order (no feeModel): price only, fee deducted', async () => {
    rz.payments.fetch.mockResolvedValue({ id: 'pay_1', order_id: 'order_1', status: 'captured', amount: 100000 });
    rz.orders.fetch.mockResolvedValue({ id: 'order_1', notes: { bookingId: '1' } });
    const out = await verify();
    expect(out).toMatchObject({ platformFee: 100, vendorAmount: 900 });
    expect(mockPrisma.payment.upsert.mock.calls[0][0].create).toMatchObject({ amount: 1000, feeModel: null });
  });

  test('on_top order but only the price was captured -> rejected', async () => {
    rz.payments.fetch.mockResolvedValue({ id: 'pay_1', order_id: 'order_1', status: 'captured', amount: 100000 });
    rz.orders.fetch.mockResolvedValue({ id: 'order_1', notes: onTopNotes });
    await expect(verify()).rejects.toMatchObject({ statusCode: 400 });
    expect(mockPrisma.payment.upsert).not.toHaveBeenCalled();
  });

  test('client-set payment notes cannot turn a legacy order into on_top with zero fee', async () => {
    rz.payments.fetch.mockResolvedValue({
      id: 'pay_1', order_id: 'order_1', status: 'captured', amount: 100000,
      notes: { feeModel: 'on_top', servicePrice: '1000.00', platformFee: '0.00' },
    });
    rz.orders.fetch.mockResolvedValue({ id: 'order_1', notes: { bookingId: '1' } });
    const out = await verify();
    expect(out).toMatchObject({ platformFee: 100, vendorAmount: 900 });
    expect(mockPrisma.payment.upsert.mock.calls[0][0].create.feeModel).toBeNull();
  });

  test('order fetch fails for an on_top order -> mismatch rejected, never mis-recorded', async () => {
    rz.payments.fetch.mockResolvedValue({ id: 'pay_1', order_id: 'order_1', status: 'captured', amount: 110000 });
    rz.orders.fetch.mockRejectedValue(new Error('network'));
    await expect(verify()).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('recordCapturedPaymentFromWebhook — on_top vs legacy', () => {
  test('on_top notes on the payment entity, order fetch fails: falls back to payment notes', async () => {
    rz.orders.fetch.mockRejectedValue(new Error('network'));
    const out = await recordCapturedPaymentFromWebhook({
      orderId: 'order_1', paymentId: 'pay_1', amountPaise: 110000, bookingIdHint: '1', notes: onTopNotes,
    });
    expect(out.created).toBe(true);
    expect(mockPrisma.payment.upsert.mock.calls[0][0].create).toMatchObject({ amount: 1100, vendorAmount: 1000, feeModel: 'on_top' });
  });

  test('legacy order: still records the old split', async () => {
    rz.orders.fetch.mockResolvedValue({ id: 'order_1', notes: { bookingId: '1' } });
    const out = await recordCapturedPaymentFromWebhook({
      orderId: 'order_1', paymentId: 'pay_1', amountPaise: 100000, bookingIdHint: '1', notes: { bookingId: '1' },
    });
    expect(out.created).toBe(true);
    expect(mockPrisma.payment.upsert.mock.calls[0][0].create).toMatchObject({ amount: 1000, vendorAmount: 900, feeModel: null });
  });

  test('on_top amount mismatch is flagged, not recorded', async () => {
    rz.orders.fetch.mockResolvedValue({ id: 'order_1', notes: onTopNotes });
    const out = await recordCapturedPaymentFromWebhook({
      orderId: 'order_1', paymentId: 'pay_1', amountPaise: 100000, bookingIdHint: '1', notes: onTopNotes,
    });
    expect(out).toMatchObject({ created: false, mismatch: true });
  });
});
