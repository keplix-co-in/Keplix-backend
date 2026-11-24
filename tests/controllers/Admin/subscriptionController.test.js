import { jest } from '@jest/globals';

const DAY = 24 * 60 * 60 * 1000;
const prisma = {
  subscriptionPlan: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
  subscriptionPayment: { findMany: jest.fn() },
  vendorSubscription: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  user: { findUnique: jest.fn() },
};
jest.unstable_mockModule('../../../util/prisma.js', () => ({ default: prisma }));
jest.unstable_mockModule('../../../util/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('razorpay', () => ({ default: jest.fn().mockImplementation(() => ({})) }));
jest.unstable_mockModule('../../../middleware/authAdminMiddleware.js', () => ({
  authAdmin: function authAdmin() {},
  authorizeAdmin: function authorizeAdmin() {},
  authorizeSuperAdmin: function authorizeSuperAdmin() {},
}));

const c = await import('../../../controllers/Admin/subscriptionController.js');
const { __resetPlanSeedCache } = await import('../../../util/subscription.js');
const { extendSubscriptionSchema, updatePlanSchema } = await import('../../../validators/subscriptionValidators.js');

const mockRes = () => { const r = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r; };
const admin = { id: 1, role: 'super_admin' };
const gold = { code: 'gold', name: 'Gold', monthly_price: 999, yearly_price: 9990, features: ['x'], sort_order: 2, is_active: true };

beforeEach(() => {
  jest.clearAllMocks();
  __resetPlanSeedCache();
  prisma.subscriptionPlan.findMany.mockResolvedValue([{ code: 'silver' }, { code: 'gold' }, { code: 'platinum' }]);
});

describe('plans', () => {
  test('list returns every plan including inactive, with is_active', async () => {
    const res = mockRes();
    prisma.subscriptionPlan.findMany.mockResolvedValue([gold, { ...gold, code: 'silver', is_active: false }]);
    await c.listPlansAdmin({ user: admin }, res);
    expect(prisma.subscriptionPlan.findMany).toHaveBeenLastCalledWith({ orderBy: { sort_order: 'asc' } });
    expect(res.json).toHaveBeenCalledWith([
      { code: 'gold', name: 'Gold', monthly_price: 999, yearly_price: 9990, features: ['x'], sort_order: 2, is_active: true },
      { code: 'silver', name: 'Gold', monthly_price: 999, yearly_price: 9990, features: ['x'], sort_order: 2, is_active: false },
    ]);
  });

  test('update applies the validated body and returns the plan; unknown code is 404 PLAN_NOT_FOUND', async () => {
    prisma.subscriptionPlan.findUnique.mockResolvedValue(gold);
    prisma.subscriptionPlan.update.mockResolvedValue({ ...gold, monthly_price: 1099 });
    const res = mockRes();
    await c.updatePlan({ user: admin, params: { code: 'GOLD' }, body: { monthly_price: 1099 } }, res);
    expect(prisma.subscriptionPlan.update).toHaveBeenCalledWith({ where: { code: 'gold' }, data: { monthly_price: 1099 } });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'gold', monthly_price: 1099, is_active: true }));

    prisma.subscriptionPlan.findUnique.mockResolvedValue(null);
    const res2 = mockRes();
    await c.updatePlan({ user: admin, params: { code: 'nope' }, body: {} }, res2);
    expect(res2.status).toHaveBeenCalledWith(404);
    expect(res2.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PLAN_NOT_FOUND' }));
  });
});

describe('vendor subscription list', () => {
  test.each([
    ['trial', (w) => expect(w).toMatchObject({ period: 'trial', ends_at: { gt: expect.any(Date) } })],
    ['active', (w) => expect(w).toMatchObject({ period: { not: 'trial' }, ends_at: { gt: expect.any(Date) } })],
    ['grace', (w) => expect(w.ends_at).toEqual({ lte: expect.any(Date), gt: expect.any(Date) })],
    ['expired', (w) => expect(w.ends_at).toEqual({ lte: expect.any(Date) })],
  ])('status=%s becomes an ends_at range filter', async (status, check) => {
    prisma.vendorSubscription.findMany.mockResolvedValue([]);
    await c.listVendorSubscriptions({ query: { status } }, mockRes());
    check(prisma.vendorSubscription.findMany.mock.calls[0][0].where);
  });

  test('unknown status is 400 and runs no query', async () => {
    const res = mockRes();
    await c.listVendorSubscriptions({ query: { status: 'bogus' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.vendorSubscription.findMany).not.toHaveBeenCalled();
  });

  test('rows carry derived status, vendor name and email; limit is capped', async () => {
    const ends = new Date(Date.now() + 5 * DAY);
    prisma.vendorSubscription.findMany.mockResolvedValue([{
      vendorId: 5, plan_code: 'gold', period: 'trial', ends_at: ends,
      vendor: { email: 'v@example.com', vendorProfile: { business_name: 'Raj Motors' } },
    }]);
    const res = mockRes();
    await c.listVendorSubscriptions({ query: { limit: '9999' } }, res);
    expect(prisma.vendorSubscription.findMany.mock.calls[0][0].take).toBeLessThanOrEqual(100);
    expect(res.json).toHaveBeenCalledWith([{
      vendor_id: 5, vendor_name: 'Raj Motors', email: 'v@example.com', plan_code: 'gold', period: 'trial', status: 'trial', ends_at: ends.toISOString(),
    }]);
  });
});

describe('extend', () => {
  const body = { days: 30, reason: 'Goodwill after outage' };
  const echo = async ({ data }) => ({ plan_code: 'gold', period: 'monthly', ends_at: data.ends_at });

  test('extends from ends_at while running, clears the reminder marker, returns the new status', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 5, role: 'vendor' });
    const ends = new Date(Date.now() + 10 * DAY);
    prisma.vendorSubscription.findUnique.mockResolvedValue({ vendorId: 5, plan_code: 'gold', period: 'monthly', starts_at: new Date(), ends_at: ends });
    prisma.vendorSubscription.update.mockImplementation(echo);
    const res = mockRes();
    await c.extendVendorSubscription({ user: admin, params: { vendorId: '5' }, body }, res);
    const { data } = prisma.vendorSubscription.update.mock.calls[0][0];
    expect(data.ends_at.getTime()).toBe(ends.getTime() + 30 * DAY);
    expect(data.last_reminder_at).toBeNull();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ vendor_id: 5, status: 'active' }));
  });

  test('a lapsed subscription is extended from now, not from the old ends_at', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 5, role: 'vendor' });
    prisma.vendorSubscription.findUnique.mockResolvedValue({ vendorId: 5, plan_code: 'gold', period: 'monthly', starts_at: new Date(), ends_at: new Date(Date.now() - 40 * DAY) });
    prisma.vendorSubscription.update.mockImplementation(echo);
    const before = Date.now();
    await c.extendVendorSubscription({ user: admin, params: { vendorId: '5' }, body }, mockRes());
    const got = prisma.vendorSubscription.update.mock.calls[0][0].data.ends_at.getTime();
    expect(got).toBeGreaterThanOrEqual(before + 30 * DAY);
    expect(got).toBeLessThan(Date.now() + 30 * DAY + 1000);
  });

  test('bad id is 400; a non-vendor is 404; nothing is written', async () => {
    const r1 = mockRes();
    await c.extendVendorSubscription({ user: admin, params: { vendorId: 'abc' }, body }, r1);
    expect(r1.status).toHaveBeenCalledWith(400);
    prisma.user.findUnique.mockResolvedValue({ id: 5, role: 'user' });
    const r2 = mockRes();
    await c.extendVendorSubscription({ user: admin, params: { vendorId: '5' }, body }, r2);
    expect(r2.status).toHaveBeenCalledWith(404);
    expect(prisma.vendorSubscription.update).not.toHaveBeenCalled();
  });

  test('validators: days 1-730, reason 3-300, non-negative prices', () => {
    expect(extendSubscriptionSchema.safeParse({ days: 30, reason: 'ok!' }).success).toBe(true);
    expect(extendSubscriptionSchema.safeParse({ days: 0, reason: 'ok!' }).success).toBe(false);
    expect(extendSubscriptionSchema.safeParse({ days: 731, reason: 'ok!' }).success).toBe(false);
    expect(extendSubscriptionSchema.safeParse({ days: 30, reason: 'x' }).success).toBe(false);
    expect(updatePlanSchema.safeParse({ monthly_price: -1 }).success).toBe(false);
  });
});

describe('payments list', () => {
  test('maps rows to the contract shape', async () => {
    const d = new Date('2026-11-20T10:00:00Z');
    prisma.subscriptionPayment.findMany.mockResolvedValue([{
      id: 3, vendorId: 5, plan_code: 'gold', period: 'monthly', amount: 999, status: 'paid',
      razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', paid_at: d, created_at: d,
      vendor: { email: 'v@example.com', vendorProfile: { business_name: 'Raj Motors' } },
    }]);
    const res = mockRes();
    await c.listSubscriptionPayments({ query: {} }, res);
    expect(res.json).toHaveBeenCalledWith([{
      id: 3, vendor_id: 5, vendor_name: 'Raj Motors', plan_code: 'gold', period: 'monthly', amount: 999, status: 'paid',
      razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', paid_at: d.toISOString(), created_at: d.toISOString(),
    }]);
  });
});

describe('admin routes: writes need super_admin, reads need any admin', () => {
  test('route stack', async () => {
    const router = (await import('../../../routes/Admin/subscriptions.js')).default;
    const names = (path, method) => router.stack.find((l) => l.route?.path === path && l.route.methods[method]).route.stack.map((s) => s.name);
    expect(names('/subscriptions/plans', 'get')).toEqual(expect.arrayContaining(['authAdmin', 'authorizeAdmin']));
    expect(names('/subscriptions/plans', 'get')).not.toContain('authorizeSuperAdmin');
    expect(names('/subscriptions/plans/:code', 'put')).toContain('authorizeSuperAdmin');
    expect(names('/subscriptions/vendors/:vendorId/extend', 'post')).toContain('authorizeSuperAdmin');
    expect(names('/subscriptions/payments', 'get')).not.toContain('authorizeSuperAdmin');
  });
});
