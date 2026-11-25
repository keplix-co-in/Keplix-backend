import { jest } from '@jest/globals';
import crypto from 'node:crypto';

process.env.RAZORPAY_KEY_ID = 'rzp_test_sub';
process.env.RAZORPAY_KEY_SECRET = 'sub_test_secret';

const DAY = 24 * 60 * 60 * 1000;
const rz = { orders: { create: jest.fn() }, payments: { fetch: jest.fn() } };
jest.unstable_mockModule('razorpay', () => ({ default: jest.fn().mockImplementation(() => rz) }));
jest.unstable_mockModule('../../util/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const prisma = {
  subscriptionPlan: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), upsert: jest.fn(), updateMany: jest.fn() },
  subscriptionPayment: { create: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn(), findMany: jest.fn() },
  vendorSubscription: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  $transaction: jest.fn(async (cb) => cb(prisma)),
};
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: prisma }));

const svc = await import('../../services/subscriptionService.js');
const { __resetPlanSeedCache } = await import('../../util/subscription.js');

const NOW = new Date('2026-11-23T10:00:00.000Z');
const goldPlan = { code: 'gold', name: 'Gold', monthly_price: 999, yearly_price: 0, features: ['a'], sort_order: 1, is_active: true };
const sign = (orderId, paymentId) => crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
const payRow = (over = {}) => ({ id: 1, vendorId: 5, plan_code: 'gold', period: 'monthly', amount: 999, razorpay_order_id: 'order_1', status: 'created', ...over });
const trialSub = (over = {}) => ({ vendorId: 5, plan_code: 'gold', period: 'trial', starts_at: new Date(NOW.getTime() - 80 * DAY), ends_at: new Date(NOW.getTime() + 10 * DAY), ...over });

beforeEach(() => {
  jest.clearAllMocks();
  __resetPlanSeedCache();
  prisma.subscriptionPlan.create.mockResolvedValue({});
  prisma.subscriptionPlan.updateMany.mockResolvedValue({ count: 2 });
  prisma.subscriptionPlan.findUnique.mockResolvedValue(goldPlan);
  prisma.subscriptionPayment.updateMany.mockResolvedValue({ count: 1 });
  prisma.vendorSubscription.findUnique.mockResolvedValue(trialSub());
  prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
});

describe('createSubscriptionOrder: amount comes from the DB plan, never the client', () => {
  beforeEach(() => rz.orders.create.mockResolvedValue({ id: 'order_1' }));

  test('monthly: charges the DB monthly price in paise and stores a created row', async () => {
    const out = await svc.createSubscriptionOrder({ vendorId: 5, plan_code: 'gold', period: 'monthly', amount: 1 });
    expect(rz.orders.create).toHaveBeenCalledWith(expect.objectContaining({
      amount: 99900, currency: 'INR', notes: { type: 'subscription', vendorId: '5', plan_code: 'gold', period: 'monthly' },
    }));
    expect(prisma.subscriptionPayment.create).toHaveBeenCalledWith({
      data: { vendorId: 5, plan_code: 'gold', period: 'monthly', amount: 999, razorpay_order_id: 'order_1', status: 'created' },
    });
    expect(out).toEqual({ order_id: 'order_1', amount: 99900, currency: 'INR', key_id: 'rzp_test_sub', plan_code: 'gold', period: 'monthly' });
  });

  test('an admin price change in the DB is what is charged', async () => {
    prisma.subscriptionPlan.findUnique.mockResolvedValue({ ...goldPlan, monthly_price: 1200.5 });
    await svc.createSubscriptionOrder({ vendorId: 5, plan_code: 'gold', period: 'monthly' });
    expect(rz.orders.create.mock.calls[0][0].amount).toBe(120050);
  });

  test('yearly (or any non-monthly period) is rejected with 400, nothing created', async () => {
    await expect(svc.createSubscriptionOrder({ vendorId: 5, plan_code: 'gold', period: 'yearly' })).rejects.toMatchObject({ status: 400 });
    expect(rz.orders.create).not.toHaveBeenCalled();
  });

  test('silver / platinum / unknown codes are rejected with 400, nothing created', async () => {
    for (const plan_code of ['silver', 'platinum', 'nope']) {
      await expect(svc.createSubscriptionOrder({ vendorId: 5, plan_code, period: 'monthly' })).rejects.toMatchObject({ status: 400 });
    }
    expect(rz.orders.create).not.toHaveBeenCalled();
  });

  test('ensures the vendor subscription row exists before creating the order (tx-safe pay)', async () => {
    await svc.createSubscriptionOrder({ vendorId: 5, plan_code: 'gold', period: 'monthly' });
    expect(prisma.vendorSubscription.findUnique).toHaveBeenCalledWith({ where: { vendorId: 5 } });
    expect(prisma.vendorSubscription.findUnique.mock.invocationCallOrder[0]).toBeLessThan(rz.orders.create.mock.invocationCallOrder[0]);
  });

  test('bad period -> 400, inactive/missing gold row -> 404, nothing created', async () => {
    await expect(svc.createSubscriptionOrder({ vendorId: 5, plan_code: 'gold', period: 'weekly' })).rejects.toMatchObject({ status: 400 });
    prisma.subscriptionPlan.findUnique.mockResolvedValue(null);
    await expect(svc.createSubscriptionOrder({ vendorId: 5, plan_code: 'gold', period: 'monthly' })).rejects.toMatchObject({ status: 404, code: 'PLAN_NOT_FOUND' });
    prisma.subscriptionPlan.findUnique.mockResolvedValue({ ...goldPlan, is_active: false });
    await expect(svc.createSubscriptionOrder({ vendorId: 5, plan_code: 'gold', period: 'monthly' })).rejects.toMatchObject({ status: 404 });
    expect(rz.orders.create).not.toHaveBeenCalled();
  });

  test('a price below Rs 1 is 422 INVALID_PLAN_PRICE before the gateway', async () => {
    prisma.subscriptionPlan.findUnique.mockResolvedValue({ ...goldPlan, monthly_price: 0.5 });
    await expect(svc.createSubscriptionOrder({ vendorId: 5, plan_code: 'gold', period: 'monthly' })).rejects.toMatchObject({ status: 422, code: 'INVALID_PLAN_PRICE' });
    expect(rz.orders.create).not.toHaveBeenCalled();
  });
});

describe('verifySubscriptionPayment', () => {
  const args = (over = {}) => ({ vendorId: 5, razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: sign('order_1', 'pay_1'), ...over });
  const captured = (over = {}) => ({ order_id: 'order_1', amount: 99900, status: 'captured', ...over });

  beforeEach(() => {
    prisma.subscriptionPayment.findUnique.mockResolvedValue(payRow());
    rz.payments.fetch.mockResolvedValue(captured());
  });

  test('happy path: marks paid, extends from ends_at (trial still running), clears the reminder marker', async () => {
    const out = await svc.verifySubscriptionPayment(args(), NOW);
    expect(prisma.subscriptionPayment.updateMany).toHaveBeenCalledWith({
      where: { razorpay_order_id: 'order_1', status: { not: 'paid' } },
      data: { status: 'paid', razorpay_payment_id: 'pay_1', paid_at: NOW },
    });
    const update = prisma.vendorSubscription.update.mock.calls[0][0];
    expect(update.where).toEqual({ vendorId: 5 });
    expect(update.data.ends_at.getTime()).toBe(NOW.getTime() + 10 * DAY + 30 * DAY);
    expect(update.data).toMatchObject({ plan_code: 'gold', period: 'monthly', last_reminder_at: null });
    expect(out).toHaveProperty('status');
  });

  test('renewal after grace starts from now', async () => {
    prisma.vendorSubscription.findUnique.mockResolvedValue(trialSub({ ends_at: new Date(NOW.getTime() - 3 * DAY) }));
    await svc.verifySubscriptionPayment(args(), NOW);
    expect(prisma.vendorSubscription.update.mock.calls[0][0].data.ends_at.getTime()).toBe(NOW.getTime() + 30 * DAY);
  });

  test('bad signature -> 400 and nothing is read or written', async () => {
    await expect(svc.verifySubscriptionPayment(args({ razorpay_signature: 'x'.repeat(64) }), NOW)).rejects.toMatchObject({ status: 400, code: 'INVALID_SIGNATURE' });
    expect(prisma.subscriptionPayment.findUnique).not.toHaveBeenCalled();
    expect(prisma.vendorSubscription.update).not.toHaveBeenCalled();
  });

  test('another vendor order -> 404 (does not reveal it exists)', async () => {
    await expect(svc.verifySubscriptionPayment(args({ vendorId: 6 }), NOW)).rejects.toMatchObject({ status: 404, code: 'ORDER_NOT_FOUND' });
    prisma.subscriptionPayment.findUnique.mockResolvedValue(null);
    await expect(svc.verifySubscriptionPayment(args(), NOW)).rejects.toMatchObject({ status: 404 });
    expect(prisma.vendorSubscription.update).not.toHaveBeenCalled();
  });

  test('amount or order mismatch at the gateway -> 400 PAYMENT_MISMATCH', async () => {
    rz.payments.fetch.mockResolvedValue(captured({ amount: 100 }));
    await expect(svc.verifySubscriptionPayment(args(), NOW)).rejects.toMatchObject({ status: 400, code: 'PAYMENT_MISMATCH' });
    rz.payments.fetch.mockResolvedValue(captured({ order_id: 'order_other' }));
    await expect(svc.verifySubscriptionPayment(args(), NOW)).rejects.toMatchObject({ status: 400, code: 'PAYMENT_MISMATCH' });
    expect(prisma.vendorSubscription.update).not.toHaveBeenCalled();
  });

  test('not captured -> 409 PAYMENT_NOT_CAPTURED; gateway fetch failure -> 502', async () => {
    rz.payments.fetch.mockResolvedValue(captured({ status: 'authorized' }));
    await expect(svc.verifySubscriptionPayment(args(), NOW)).rejects.toMatchObject({ status: 409, code: 'PAYMENT_NOT_CAPTURED' });
    rz.payments.fetch.mockRejectedValue(new Error('down'));
    await expect(svc.verifySubscriptionPayment(args(), NOW)).rejects.toMatchObject({ status: 502 });
    expect(prisma.vendorSubscription.update).not.toHaveBeenCalled();
  });

  test('idempotent: an already paid order does not extend again nor call the gateway', async () => {
    prisma.subscriptionPayment.findUnique.mockResolvedValue(payRow({ status: 'paid' }));
    await svc.verifySubscriptionPayment(args(), NOW);
    expect(rz.payments.fetch).not.toHaveBeenCalled();
    expect(prisma.vendorSubscription.update).not.toHaveBeenCalled();
  });

  test('idempotent under a race: losing the guarded claim (count 0) does not extend', async () => {
    prisma.subscriptionPayment.updateMany.mockResolvedValue({ count: 0 });
    await svc.verifySubscriptionPayment(args(), NOW);
    expect(prisma.vendorSubscription.update).not.toHaveBeenCalled();
  });
});

describe('handleSubscriptionCaptured (webhook branch)', () => {
  beforeEach(() => prisma.subscriptionPayment.findUnique.mockResolvedValue(payRow()));

  test('applies once; the replay is a no-op', async () => {
    expect(await svc.handleSubscriptionCaptured({ orderId: 'order_1', paymentId: 'pay_1', amountPaise: 99900 })).toEqual({ applied: true });
    expect(prisma.vendorSubscription.update).toHaveBeenCalledTimes(1);
    prisma.subscriptionPayment.updateMany.mockResolvedValue({ count: 0 });
    expect(await svc.handleSubscriptionCaptured({ orderId: 'order_1', paymentId: 'pay_1', amountPaise: 99900 })).toEqual({ applied: false });
    expect(prisma.vendorSubscription.update).toHaveBeenCalledTimes(1);
  });

  test('unknown order -> unresolved; wrong amount (checked against OUR row) -> mismatch, nothing applied', async () => {
    prisma.subscriptionPayment.findUnique.mockResolvedValue(null);
    expect(await svc.handleSubscriptionCaptured({ orderId: 'order_x', paymentId: 'p', amountPaise: 1 })).toEqual({ unresolved: true });
    prisma.subscriptionPayment.findUnique.mockResolvedValue(payRow());
    expect(await svc.handleSubscriptionCaptured({ orderId: 'order_1', paymentId: 'p', amountPaise: 100 })).toEqual({ mismatch: true });
    expect(prisma.vendorSubscription.update).not.toHaveBeenCalled();
  });

  test('payment.failed only flips a created row to failed', async () => {
    await svc.handleSubscriptionFailed({ orderId: 'order_1' });
    expect(prisma.subscriptionPayment.updateMany).toHaveBeenCalledWith({ where: { razorpay_order_id: 'order_1', status: 'created' }, data: { status: 'failed' } });
    prisma.subscriptionPayment.updateMany.mockClear();
    await svc.handleSubscriptionFailed({});
    expect(prisma.subscriptionPayment.updateMany).not.toHaveBeenCalled();
  });

  test('isSubscriptionNotes', () => {
    expect(svc.isSubscriptionNotes({ type: 'subscription' })).toBe(true);
    expect(svc.isSubscriptionNotes({ bookingId: '1' })).toBe(false);
    expect(svc.isSubscriptionNotes(undefined)).toBe(false);
  });
});

describe('read models', () => {
  test('listPlans returns active plans in the contract shape', async () => {
    prisma.subscriptionPlan.findMany.mockResolvedValue([goldPlan]);
    expect(await svc.listPlans()).toEqual([{ code: 'gold', name: 'Gold', monthly_price: 999, features: ['a'], sort_order: 1 }]);
    expect(prisma.subscriptionPlan.findMany).toHaveBeenLastCalledWith({ where: { is_active: true }, orderBy: { sort_order: 'asc' } });
  });

  test('getMySubscription lazily creates the 90-day trial', async () => {
    prisma.vendorSubscription.findUnique.mockResolvedValue(null);
    prisma.vendorSubscription.create.mockImplementation(async ({ data }) => data);
    const out = await svc.getMySubscription(5, NOW);
    expect(out).toMatchObject({ plan_code: 'gold', plan_name: 'Gold', period: 'trial', status: 'trial', days_left: 90 });
  });

  test('listMyPayments maps rows (amount in rupees, ISO dates)', async () => {
    prisma.subscriptionPayment.findMany.mockResolvedValue([payRow({ status: 'paid', paid_at: NOW, created_at: NOW })]);
    expect(await svc.listMyPayments(5)).toEqual([{
      id: 1, plan_code: 'gold', period: 'monthly', amount: 999, status: 'paid', paid_at: NOW.toISOString(), created_at: NOW.toISOString(),
    }]);
  });
});
