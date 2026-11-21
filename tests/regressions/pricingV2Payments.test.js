import { jest } from '@jest/globals';
import crypto from 'node:crypto';

// Pricing v2 payments (docs/PRICING_V2_API.md section 6): for a booking with a
// BookingQuote, all three paths (order create, client verify, webhook) charge
// the open final bill's total via resolveChargeableAmount. No bill yet ->
// BILL_NOT_READY / capture rejected. A recorded payment marks the bill paid
// and writes a final_bill_paid BookingEvent in the same transaction.
// Harness follows feeOnTopPayments.test.js (10% fee on top).

const settings = { current: { isPlatformFeeEnabled: true, platformFeePercentage: 0.1 } };
const tx = {
  $queryRaw: jest.fn().mockResolvedValue([]),
  payment: { upsert: jest.fn(), update: jest.fn() },
  booking: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUnique: jest.fn().mockResolvedValue({ id: 1, status: 'in_progress', vendor_status: 'accepted', service: { vendorId: 42 } }),
  },
  finalBill: { updateMany: jest.fn(), findUnique: jest.fn() },
  bookingEvent: { create: jest.fn() },
};
const mockPrisma = {
  booking: { findUnique: jest.fn() },
  payment: { findUnique: jest.fn(), findFirst: jest.fn() },
  platformSettings: { findFirst: jest.fn(async () => settings.current) },
  $transaction: jest.fn(async (cb) => cb(tx)),
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
const { resolveChargeableAmount } = await import('../../util/servicePricing.js');

const SECRET = 'v2_test_secret';
const sig = (o, p) => crypto.createHmac('sha256', SECRET).update(`${o}|${p}`).digest('hex');
const dec = (n) => ({ toString: () => String(n) });
const issuedBill = { id: 3, status: 'issued', total: dec('7800.00') };
// Service price 1000 and price snapshot 1000: a v2 charge must ignore both.
const v2Booking = (o = {}) => ({
  id: 1, userId: 7, status: 'in_progress', vendor_status: 'accepted',
  service: { id: 1, price: dec(1000), vendorId: 42 },
  bookingVehicle: { price_snapshot: dec(1000) },
  bookingQuote: { id: 9 },
  finalBills: [issuedBill],
  ...o,
});
const v2Notes = { bookingId: '1', servicePrice: '7800.00', platformFee: '780.00', feeRate: '0.1', feeModel: 'on_top', finalBillId: '3' };
const res = () => { const r = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r; };

beforeAll(() => { process.env.RAZORPAY_KEY_SECRET = SECRET; });
beforeEach(() => {
  jest.clearAllMocks();
  settings.current = { isPlatformFeeEnabled: true, platformFeePercentage: 0.1 };
  mockPrisma.booking.findUnique.mockResolvedValue(v2Booking());
  mockPrisma.payment.findUnique.mockResolvedValue(null);
  mockPrisma.payment.findFirst.mockResolvedValue(null);
  tx.payment.upsert.mockImplementation(async ({ create }) => ({ id: 99, ...create }));
  tx.finalBill.updateMany.mockResolvedValue({ count: 1 });
  tx.finalBill.findUnique.mockResolvedValue({ status: 'paid' });
  mockPrisma.platformSettings.findFirst.mockImplementation(async () => settings.current);
  rz.orders.all.mockResolvedValue({ items: [] });
  rz.orders.create.mockImplementation(async (p) => ({ id: 'order_new', ...p }));
});

describe('resolveChargeableAmount (the one helper all paths use)', () => {
  test('legacy booking: snapshot price, unchanged', () => {
    expect(resolveChargeableAmount(v2Booking({ bookingQuote: null }))).toEqual({ flow: 'legacy', amount: 1000, finalBillId: null, billStatus: null });
  });
  test('v2 booking: the bill total and id; no bill -> amount null', () => {
    expect(resolveChargeableAmount(v2Booking())).toEqual({ flow: 'v2', amount: 7800, finalBillId: 3, billStatus: 'issued' });
    expect(resolveChargeableAmount(v2Booking({ finalBills: [] })).amount).toBeNull();
  });
});

describe('path 1: createPaymentOrder', () => {
  test('charges the bill total + fee and records the bill id in the notes', async () => {
    const r = res();
    await createPaymentOrder({ body: { bookingId: 1 }, user: { id: 7 } }, r);
    expect(rz.orders.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 858000, notes: v2Notes }));
  });

  test('no issued bill -> 409 BILL_NOT_READY, no order', async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(v2Booking({ finalBills: [] }));
    const r = res();
    await createPaymentOrder({ body: { bookingId: 1 }, user: { id: 7 } }, r);
    expect(r.status).toHaveBeenCalledWith(409);
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'BILL_NOT_READY' }));
    expect(rz.orders.create).not.toHaveBeenCalled();
  });

  test('bill already paid -> 409 ALREADY_PAID', async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(v2Booking({ finalBills: [{ ...issuedBill, status: 'paid' }] }));
    const r = res();
    await createPaymentOrder({ body: { bookingId: 1 }, user: { id: 7 } }, r);
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ALREADY_PAID' }));
  });

  test('legacy booking: notes stay exactly as before (no finalBillId)', async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(v2Booking({ bookingQuote: null, finalBills: [] }));
    await createPaymentOrder({ body: { bookingId: 1 }, user: { id: 7 } }, res());
    const { amount, notes } = rz.orders.create.mock.calls[0][0];
    expect(amount).toBe(110000);
    expect(notes).not.toHaveProperty('finalBillId');
  });

  test('quote uses the same helper: bill total, or BILL_NOT_READY', async () => {
    const r = res();
    await getPaymentQuote({ params: { bookingId: '1' }, user: { id: 7 } }, r);
    expect(r.json).toHaveBeenCalledWith({ success: true, data: { servicePrice: 7800, platformFee: 780, feeRate: 0.1, total: 8580 } });
    mockPrisma.booking.findUnique.mockResolvedValue(v2Booking({ finalBills: [] }));
    const r2 = res();
    await getPaymentQuote({ params: { bookingId: '1' }, user: { id: 7 } }, r2);
    expect(r2.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'BILL_NOT_READY' }));
  });
});

describe('path 2: verifyAndRecordPayment', () => {
  const verify = () => verifyAndRecordPayment({
    bookingId: 1, requestingUserId: 7, orderId: 'order_1', paymentId: 'pay_1', signature: sig('order_1', 'pay_1'),
  });

  test('records the bill total, marks the bill paid and writes the audit event', async () => {
    rz.payments.fetch.mockResolvedValue({ id: 'pay_1', order_id: 'order_1', status: 'captured', amount: 858000 });
    rz.orders.fetch.mockResolvedValue({ id: 'order_1', notes: v2Notes });
    const out = await verify();
    expect(out).toMatchObject({ platformFee: 780, vendorAmount: 7800 });
    expect(tx.payment.upsert.mock.calls[0][0].create).toMatchObject({ amount: 8580, vendorAmount: 7800 });
    expect(tx.finalBill.updateMany).toHaveBeenCalledWith({
      where: { id: 3, bookingId: 1, status: 'issued' },
      data: { status: 'paid', paid_at: expect.any(Date) },
    });
    expect(tx.bookingEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ bookingId: 1, actor_role: 'system', type: 'final_bill_paid' }),
    });
  });

  test('no bill: any capture is rejected, nothing recorded', async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(v2Booking({ finalBills: [] }));
    rz.payments.fetch.mockResolvedValue({ id: 'pay_1', order_id: 'order_1', status: 'captured', amount: 858000 });
    rz.orders.fetch.mockResolvedValue({ id: 'order_1', notes: v2Notes });
    await expect(verify()).rejects.toMatchObject({ statusCode: 400 });
    expect(tx.payment.upsert).not.toHaveBeenCalled();
  });

  test('capture for the old quote price (not the bill) is rejected', async () => {
    rz.payments.fetch.mockResolvedValue({ id: 'pay_1', order_id: 'order_1', status: 'captured', amount: 110000 });
    rz.orders.fetch.mockResolvedValue({ id: 'order_1', notes: { ...v2Notes, servicePrice: '1000.00', platformFee: '100.00' } });
    await expect(verify()).rejects.toMatchObject({ statusCode: 400 });
  });

  test('legacy payment never touches bill tables', async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(v2Booking({ bookingQuote: null, finalBills: [] }));
    rz.payments.fetch.mockResolvedValue({ id: 'pay_1', order_id: 'order_1', status: 'captured', amount: 100000 });
    rz.orders.fetch.mockResolvedValue({ id: 'order_1', notes: { bookingId: '1' } });
    await verify();
    expect(tx.finalBill.updateMany).not.toHaveBeenCalled();
    expect(tx.bookingEvent.create).not.toHaveBeenCalled();
  });
});

describe('path 3: recordCapturedPaymentFromWebhook', () => {
  test('records the bill total and marks the bill paid', async () => {
    rz.orders.fetch.mockResolvedValue({ id: 'order_1', notes: v2Notes });
    const out = await recordCapturedPaymentFromWebhook({ orderId: 'order_1', paymentId: 'pay_1', amountPaise: 858000, bookingIdHint: '1', notes: v2Notes });
    expect(out.created).toBe(true);
    expect(tx.finalBill.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 3, bookingId: 1, status: 'issued' } }));
  });

  test('no bill -> flagged unresolved, nothing recorded', async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(v2Booking({ finalBills: [] }));
    rz.orders.fetch.mockResolvedValue({ id: 'order_1', notes: v2Notes });
    const out = await recordCapturedPaymentFromWebhook({ orderId: 'order_1', paymentId: 'pay_1', amountPaise: 858000, bookingIdHint: '1', notes: v2Notes });
    expect(out).toMatchObject({ created: false, unresolved: true });
    expect(tx.payment.upsert).not.toHaveBeenCalled();
  });

  // Review fix 2026-11-21 (void race): this used to pass silently ("no
  // event"). The payment is still kept (money moved, no auto-refund) but is
  // now flagged with a BookingEvent and a [MANUAL ACTION] log.
  test('bill voided between order and capture (guard count 0): payment kept AND flagged', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    tx.finalBill.updateMany.mockResolvedValue({ count: 0 });
    tx.finalBill.findUnique.mockResolvedValue({ status: 'void' });
    rz.orders.fetch.mockResolvedValue({ id: 'order_1', notes: v2Notes });
    await recordCapturedPaymentFromWebhook({ orderId: 'order_1', paymentId: 'pay_1', amountPaise: 858000, bookingIdHint: '1', notes: v2Notes });
    expect(tx.payment.upsert).toHaveBeenCalled();
    expect(tx.bookingEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.bookingEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ bookingId: 1, type: 'payment_bill_mismatch', payload: expect.objectContaining({ finalBillId: 3, paymentId: 99 }) }),
    });
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[MANUAL ACTION\].*bill 3.*void/));
    errSpy.mockRestore();
  });
});

describe('review fix 2026-11-21: escrow hold + confirm window on v2 payment', () => {
  const verify = () => verifyAndRecordPayment({
    bookingId: 1, requestingUserId: 7, orderId: 'order_1', paymentId: 'pay_1', signature: sig('order_1', 'pay_1'),
  });
  const captured = () => {
    rz.payments.fetch.mockResolvedValue({ id: 'pay_1', order_id: 'order_1', status: 'captured', amount: 858000 });
    rz.orders.fetch.mockResolvedValue({ id: 'order_1', notes: v2Notes });
  };
  const HOUR = 3600 * 1000;
  const windowRestart = () => tx.booking.updateMany.mock.calls.find(([a]) => a.where.status === 'service_completed');

  test('verify: sets payoutHoldUntil = now + payoutHoldHours (default 24h) and restarts service_completed_at', async () => {
    captured();
    const before = Date.now();
    await verify();
    expect(tx.payment.update).toHaveBeenCalledTimes(1);
    const { where, data } = tx.payment.update.mock.calls[0][0];
    expect(where).toEqual({ id: 99 });
    const held = data.payoutHoldUntil.getTime() - before;
    expect(held).toBeGreaterThanOrEqual(24 * HOUR);
    expect(held).toBeLessThan(24 * HOUR + 5000);
    expect(windowRestart()[0]).toEqual({ where: { id: 1, status: 'service_completed' }, data: { service_completed_at: expect.any(Date) } });
  });

  test('uses the admin payoutHoldHours setting, same as completion', async () => {
    settings.current = { ...settings.current, payoutHoldHours: 6 };
    captured();
    const before = Date.now();
    await verify();
    const held = tx.payment.update.mock.calls[0][0].data.payoutHoldUntil.getTime() - before;
    expect(held).toBeGreaterThanOrEqual(6 * HOUR);
    expect(held).toBeLessThan(6 * HOUR + 5000);
  });

  test('payoutHoldHours 0 = no hold (as at completion), window still restarted', async () => {
    settings.current = { ...settings.current, payoutHoldHours: 0 };
    captured();
    await verify();
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(windowRestart()).toBeDefined();
  });

  test('a settings read failure does not lose the payment (best-effort, like completion)', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    captured();
    // An on_top charge takes its fee from the order notes, so the only
    // settings read on this path is the hold; make it fail.
    mockPrisma.platformSettings.findFirst.mockImplementation(async () => { throw new Error('db blip'); });
    await verify();
    expect(tx.payment.upsert).toHaveBeenCalled();
    expect(tx.finalBill.updateMany).toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('webhook path: same hold and window restart', async () => {
    rz.orders.fetch.mockResolvedValue({ id: 'order_1', notes: v2Notes });
    await recordCapturedPaymentFromWebhook({ orderId: 'order_1', paymentId: 'pay_1', amountPaise: 858000, bookingIdHint: '1', notes: v2Notes });
    expect(tx.payment.update).toHaveBeenCalledWith({ where: { id: 99 }, data: { payoutHoldUntil: expect.any(Date) } });
    expect(windowRestart()).toBeDefined();
  });

  test('legacy payment: no hold set here and confirm window untouched (completion still owns both)', async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(v2Booking({ bookingQuote: null, finalBills: [] }));
    rz.payments.fetch.mockResolvedValue({ id: 'pay_1', order_id: 'order_1', status: 'captured', amount: 100000 });
    rz.orders.fetch.mockResolvedValue({ id: 'order_1', notes: { bookingId: '1' } });
    await verify();
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(windowRestart()).toBeUndefined();
    expect(tx.finalBill.findUnique).not.toHaveBeenCalled();
  });
});

describe('review fix 2026-11-21: void race is flagged, never silent', () => {
  const verify = () => verifyAndRecordPayment({
    bookingId: 1, requestingUserId: 7, orderId: 'order_1', paymentId: 'pay_1', signature: sig('order_1', 'pay_1'),
  });
  let errSpy;
  beforeEach(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => errSpy.mockRestore());
  const manualActions = () => errSpy.mock.calls.filter(([m]) => typeof m === 'string' && m.startsWith('[MANUAL ACTION]'));
  const captured = (notes = v2Notes) => {
    rz.payments.fetch.mockResolvedValue({ id: 'pay_1', order_id: 'order_1', status: 'captured', amount: 858000 });
    rz.orders.fetch.mockResolvedValue({ id: 'order_1', notes });
  };

  test('order made for bill 2, bill 2 voided and re-issued as bill 3 with the same total: recorded on 3, flagged', async () => {
    captured({ ...v2Notes, finalBillId: '2' });
    await verify();
    expect(tx.finalBill.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 3, bookingId: 1, status: 'issued' } }));
    expect(tx.bookingEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'payment_bill_mismatch', payload: expect.objectContaining({ finalBillId: 3, orderFinalBillId: '2' }) }),
    });
    expect(manualActions()).toHaveLength(1);
    expect(manualActions()[0][0]).toMatch(/order made for bill 2/);
  });

  test('bill voided inside the commit window on verify: flagged, payment kept, no auto-refund', async () => {
    tx.finalBill.updateMany.mockResolvedValue({ count: 0 });
    tx.finalBill.findUnique.mockResolvedValue({ status: 'void' });
    captured();
    const out = await verify();
    expect(out.payment).toMatchObject({ id: 99 });
    expect(rz.payments.refund).toBeUndefined();
    expect(manualActions()).toHaveLength(1);
  });

  test('bill already paid (replay / another path won): no flag, no extra event', async () => {
    tx.finalBill.updateMany.mockResolvedValue({ count: 0 });
    tx.finalBill.findUnique.mockResolvedValue({ status: 'paid' });
    captured();
    await verify();
    expect(tx.bookingEvent.create).not.toHaveBeenCalled();
    expect(manualActions()).toHaveLength(0);
  });

  test('normal payment: exactly one event (final_bill_paid), no flag', async () => {
    captured();
    await verify();
    expect(tx.bookingEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.bookingEvent.create.mock.calls[0][0].data.type).toBe('final_bill_paid');
    expect(manualActions()).toHaveLength(0);
  });
});
