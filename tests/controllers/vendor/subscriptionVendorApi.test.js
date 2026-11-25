/**
 * Vendor subscription API (docs/SUBSCRIPTIONS_API.md): controller envelope,
 * validators, route guards; pay-the-garage validators and pricing shape;
 * new notification templates.
 */
import { jest } from '@jest/globals';

const svc = {
  SubscriptionError: class SubscriptionError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  },
  listPlans: jest.fn(), getMySubscription: jest.fn(), listMyPayments: jest.fn(),
  createSubscriptionOrder: jest.fn(), verifySubscriptionPayment: jest.fn(),
};
jest.unstable_mockModule('../../../services/subscriptionService.js', () => svc);
jest.unstable_mockModule('../../../util/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('razorpay', () => ({ default: jest.fn().mockImplementation(() => ({})) }));
jest.unstable_mockModule('../../../middleware/authMiddleware.js', () => ({
  protect: function protect() {}, vendorOnly: function vendorOnly() {}, requireApprovedVendor: function requireApprovedVendor() {},
}));

const c = await import('../../../controllers/vendor/subscriptionController.js');
const { createSubscriptionOrderSchema, verifySubscriptionSchema } = await import('../../../validators/subscriptionValidators.js');
const { markPaidSchema, extraWorkSchema } = await import('../../../validators/pricingV2Validators.js');
const { renderNotification, NOTIFICATION_TYPES } = await import('../../../util/notificationTemplates.js');
const { buildPricingView, billOut } = await import('../../../util/pricingV2.js');

const mockRes = () => { const r = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r; };
const req = (body = {}) => ({ user: { id: 5 }, body });

beforeEach(() => jest.clearAllMocks());

describe('vendor controller', () => {
  test('plans, me and payments return the service output as plain JSON', async () => {
    svc.listPlans.mockResolvedValue([{ code: 'gold' }]);
    svc.getMySubscription.mockResolvedValue({ status: 'trial' });
    svc.listMyPayments.mockResolvedValue([]);
    const a = mockRes(); await c.getPlans(req(), a); expect(a.json).toHaveBeenCalledWith([{ code: 'gold' }]);
    const b = mockRes(); await c.getMe(req(), b); expect(b.json).toHaveBeenCalledWith({ status: 'trial' });
    expect(svc.getMySubscription).toHaveBeenCalledWith(5);
    const d = mockRes(); await c.getPayments(req(), d); expect(d.json).toHaveBeenCalledWith([]);
  });

  test('createOrder passes only plan_code and period: a client-sent amount is ignored', async () => {
    svc.createSubscriptionOrder.mockResolvedValue({ order_id: 'o' });
    await c.createOrder(req({ plan_code: 'gold', period: 'monthly', amount: 1, price: 1 }), mockRes());
    expect(svc.createSubscriptionOrder).toHaveBeenCalledWith({ vendorId: 5, plan_code: 'gold', period: 'monthly' });
  });

  test('errors use the dual envelope { success:false, message, code, error:{code,message} }', async () => {
    svc.verifySubscriptionPayment.mockRejectedValue(new svc.SubscriptionError(409, 'PAYMENT_NOT_CAPTURED', 'not captured'));
    const res = mockRes();
    await c.verify(req({}), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'not captured', code: 'PAYMENT_NOT_CAPTURED', error: { code: 'PAYMENT_NOT_CAPTURED', message: 'not captured' } });
  });

  test('a raw gateway error while creating the order is a 502 GATEWAY_ERROR; anything else a 500 without details', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    svc.createSubscriptionOrder.mockRejectedValueOnce({ statusCode: 401, error: { description: 'Authentication failed' } });
    const r1 = mockRes(); await c.createOrder(req({ plan_code: 'gold', period: 'monthly' }), r1);
    expect(r1.status).toHaveBeenCalledWith(502);
    expect(r1.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'GATEWAY_ERROR' }));
    svc.getMySubscription.mockRejectedValueOnce(new Error('secret db detail'));
    const r2 = mockRes(); await c.getMe(req(), r2);
    expect(r2.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(r2.json.mock.calls[0][0])).not.toContain('secret db detail');
    spy.mockRestore();
  });
});

describe('validators', () => {
  test('order: only plan gold + period monthly are accepted', () => {
    expect(createSubscriptionOrderSchema.safeParse({ plan_code: 'gold', period: 'yearly' }).success).toBe(false);
    expect(createSubscriptionOrderSchema.safeParse({ plan_code: 'gold', period: 'monthly' }).success).toBe(true);
    expect(createSubscriptionOrderSchema.safeParse({ plan_code: 'silver', period: 'monthly' }).success).toBe(false);
    expect(createSubscriptionOrderSchema.safeParse({ plan_code: 'platinum', period: 'monthly' }).success).toBe(false);
    expect(createSubscriptionOrderSchema.safeParse({ plan_code: 'gold', period: 'trial' }).success).toBe(false);
    expect(createSubscriptionOrderSchema.safeParse({ period: 'monthly' }).success).toBe(false);
  });
  test('verify needs the three Razorpay fields', () => {
    expect(verifySubscriptionSchema.safeParse({ razorpay_order_id: 'o', razorpay_payment_id: 'p', razorpay_signature: 's' }).success).toBe(true);
    expect(verifySubscriptionSchema.safeParse({ razorpay_order_id: 'o' }).success).toBe(false);
  });
  test('mark-paid method must be cash, upi or card', () => {
    for (const method of ['cash', 'upi', 'card']) expect(markPaidSchema.safeParse({ method }).success).toBe(true);
    expect(markPaidSchema.safeParse({ method: 'bitcoin' }).success).toBe(false);
    expect(markPaidSchema.safeParse({}).success).toBe(false);
  });
  test('job_key is optional, trimmed, 1-40 chars', () => {
    const base = { reason: 'Found during inspection', items: [{ kind: 'part', name: 'Pads', qty: 1, unit_price: 100 }] };
    expect(extraWorkSchema.safeParse(base).success).toBe(true);
    const withKey = (job_key) => extraWorkSchema.safeParse({ ...base, items: [{ ...base.items[0], job_key }] });
    expect(withKey('brakes').success).toBe(true);
    expect(withKey('x'.repeat(41)).success).toBe(false);
    expect(withKey('').success).toBe(false);
    expect(withKey('  brakes ').data.items[0].job_key).toBe('brakes');
  });
});

describe('route guards', () => {
  test('vendor subscription routes sit behind protect + vendorOnly + requireApprovedVendor; plans is public', async () => {
    const router = (await import('../../../routes/vendor/subscriptions.js')).default;
    const stack = (path, method) => router.stack.find((l) => l.route?.path === path && l.route.methods[method]).route.stack.map((s) => s.name);
    for (const [p, m] of [['/me', 'get'], ['/order', 'post'], ['/verify', 'post'], ['/payments', 'get']]) {
      expect(stack(p, m)).toEqual(expect.arrayContaining(['protect', 'vendorOnly', 'requireApprovedVendor']));
    }
    expect(stack('/plans', 'get')).toEqual(['getPlans']);
  });
});

describe('pay_to and bill paid_method in the pricing view', () => {
  const booking = (over = {}) => ({
    id: 1, userId: 2, status: 'in_progress', vendor_status: 'accepted', payment: null,
    service: { vendorId: 3, vendor: { vendorProfile: { business_name: 'Raj Motors', upi_id: 'raj@upi' } } },
    bookingQuote: { pricing_type: 'fixed', inspection_fee: null, lines: [], inclusions: [], exclusions: [], tax_inclusive: true },
    bookingJob: { checked_in_at: new Date() }, extraWorkRequests: [], finalBills: [], ...over,
  });

  test('pay_to carries the garage UPI id and name (null when the garage has none)', () => {
    expect(buildPricingView(booking(), 'user').pay_to).toEqual({ upi_id: 'raj@upi', garage_name: 'Raj Motors' });
    const none = booking({ service: { vendorId: 3, vendor: { vendorProfile: { business_name: 'Raj Motors', upi_id: null } } } });
    expect(buildPricingView(none, 'user').pay_to.upi_id).toBeNull();
  });

  test('billOut exposes paid_method', () => {
    const out = billOut({ id: 1, number: 'KPX-1', status: 'paid', total: 100, lines: [], paid_method: 'upi', paid_at: new Date() });
    expect(out.paid_method).toBe('upi');
  });
});

describe('notification templates', () => {
  test('FINAL_BILL_MARKED_PAID mentions the booking and tap-navigates', () => {
    const n = renderNotification(NOTIFICATION_TYPES.FINAL_BILL_MARKED_PAID, { bookingId: 12, garageName: 'Raj Motors', amount: 500 });
    expect(n.type).toBe('final_bill_marked_paid');
    expect(n.body).toContain('Raj Motors');
    expect(n.data.bookingId).toBe(12);
  });
  test('SUBSCRIPTION_REMINDER: before expiry and in grace, with a vendor screen payload', () => {
    const before = renderNotification(NOTIFICATION_TYPES.SUBSCRIPTION_REMINDER, { daysLeft: 3, graceDaysLeft: null });
    expect(before.body).toContain('ends in 3 days');
    const grace = renderNotification(NOTIFICATION_TYPES.SUBSCRIPTION_REMINDER, { daysLeft: 0, graceDaysLeft: 1 });
    expect(grace.body).toContain('hidden from customers in 1 day.');
    expect(before.data).toMatchObject({ type: 'subscription_reminder', screen: 'Subscription' });
    expect(renderNotification(NOTIFICATION_TYPES.SUBSCRIPTION_REMINDER, {}).body).toContain('has ended');
  });
});
