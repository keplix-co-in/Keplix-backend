import { jest } from '@jest/globals';
import crypto from 'node:crypto';

/**
 * SUBSCRIPTION WORKFLOW E2E (single plan "Keplix Partner", Rs 999/month, 90-day trial).
 *
 * Runs against a THROWAWAY local Postgres only (see the guard below). Only the
 * Supabase token verifier and the Razorpay SDK are faked; routes, controllers,
 * services, validators, the raw-body webhook route and Prisma are all real.
 *
 *   docker run -d --name keplix-e2e-pg -e POSTGRES_PASSWORD=e2e -e POSTGRES_DB=keplix_e2e -p 127.0.0.1:58432:5432 postgres:15-alpine
 *   npx prisma db push --schema prisma/schema.prisma --url postgresql://postgres:e2e@localhost:58432/keplix_e2e
 *   NODE_OPTIONS=--experimental-vm-modules npx jest tests/e2e/05-subscription-workflow --runInBand --forceExit
 */

// jest.config.js loads .env via dotenv/config (which never overrides an
// already-set var). Force our own values here, before ANY app import.
const LOCAL_URL = process.env.E2E_DATABASE_URL || 'postgresql://postgres:e2e@localhost:58432/keplix_e2e';
process.env.DATABASE_URL = LOCAL_URL;
process.env.DIRECT_URL = LOCAL_URL;
const dbHost = new URL(process.env.DATABASE_URL).hostname;
if (!['localhost', '127.0.0.1'].includes(dbHost)) {
  throw new Error(`REFUSING TO RUN: DATABASE_URL host is "${dbHost}", not localhost`);
}
console.log(`[e2e-subscription] DB host = ${dbHost}:${new URL(process.env.DATABASE_URL).port}`);

process.env.RAZORPAY_KEY_SECRET = 'e2e_test_key_secret';
process.env.RAZORPAY_KEY_ID = 'rzp_test_e2e';
process.env.RAZORPAY_WEBHOOK_SECRET = 'e2e_test_webhook_secret';

const { razorpayFake, paymentSignature, capturedPaymentWebhook } = await import('./helpers/razorpay.js');
jest.unstable_mockModule('razorpay', () => ({
  default: jest.fn().mockImplementation(() => razorpayFake),
}));

// Only the token verifier is faked: token "tok:<uuid>" maps to claims for that supabase user.
const realAuth = await import('../../util/supabaseAuth.js');
jest.unstable_mockModule('../../util/supabaseAuth.js', () => ({
  ...realAuth,
  verifySupabaseToken: async (token) => {
    if (!String(token).startsWith('tok:')) throw new Error('bad token');
    return { sub: String(token).slice(4), email: null, iat: Math.floor(Date.now() / 1000) };
  },
}));

const request = (await import('supertest')).default;
const app = (await import('../../app.js')).default;
const prisma = (await import('../../util/prisma.js')).default;
const { __resetPlanSeedCache, TRIAL_DAYS } = await import('../../util/subscription.js');

const DAY = 24 * 60 * 60 * 1000;
const uuid = () => crypto.randomUUID();
const bearer = (sid) => ({ Authorization: `Bearer tok:${sid}` });
const near = (a, b, tolMs = 5 * 60 * 1000) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) <= tolMs;
const ms = (d) => new Date(d).getTime();

let seq = 0;
const makeVendor = async ({ complete = true } = {}) => {
  const n = `${Date.now()}${++seq}`;
  const supabaseId = uuid();
  const user = await prisma.user.create({
    data: { email: `v${n}@keplix-e2e.invalid`, role: 'vendor', is_verified: true, supabaseId },
  });
  await prisma.vendorProfile.create({
    data: {
      userId: user.id, business_name: `E2E Garage ${n}`, owner_name: 'Owner', phone: '9000000000',
      address: '1 Test Road', city: 'Pune', pincode: '411001', latitude: 18.52, longitude: 73.85,
      operating_hours: '09:00-18:00', upi_id: complete ? 'e2e@upi' : null, is_online: true,
    },
  });
  if (complete) {
    await prisma.document.create({ data: { vendorId: user.id, document_type: 'pan_card', file_url: 'https://x.invalid/pan.jpg' } });
  }
  return { user, supabaseId, h: bearer(supabaseId) };
};

let admin; let customer;
const approve = (v) => request(app).patch(`/admin/vendors/${v.user.id}/status`).set(admin.h).send({ status: 'approved' });
const subRow = (v) => prisma.vendorSubscription.findUnique({ where: { vendorId: v.user.id } });
const orderFor = (v) => request(app).post('/subscriptions/order').set(v.h).send({ plan_code: 'gold', period: 'monthly' });
const slots = (v) => request(app).get(`/service_api/user/vendors/${v.user.id}/slots?date=2030-01-07`).set(customer.h);
const search = async (v) => {
  const r = await request(app).get('/service_api/search?latitude=18.52&longitude=73.85&radius=5');
  return (r.body.vendors || []).some((x) => x.id === v.user.id);
};
// Pays an order through the gateway fake and calls verify with a real HMAC.
const payAndVerify = async (v, order, paymentId) => {
  razorpayFake.seedCapturedPayment({ paymentId, orderId: order.order_id, amountPaise: order.amount });
  return request(app).post('/subscriptions/verify').set(v.h).send({
    razorpay_order_id: order.order_id, razorpay_payment_id: paymentId,
    razorpay_signature: paymentSignature(order.order_id, paymentId),
  });
};

beforeAll(async () => {
  // Throwaway local DB (host guard above): start every run from a clean slate.
  await prisma.$executeRawUnsafe('TRUNCATE "SubscriptionPayment","VendorSubscription","SubscriptionPlan","WebhookEvent","Document","VendorProfile","Admin","User" RESTART IDENTITY CASCADE');
  const adminSid = uuid();
  const a = await prisma.admin.create({
    data: { name: 'E2E Admin', email: `a${Date.now()}@keplix-e2e.invalid`, role: 'super_admin', supabaseId: adminSid },
  });
  admin = { row: a, h: bearer(adminSid) };
  const csid = uuid();
  const c = await prisma.user.create({
    data: { email: `c${Date.now()}@keplix-e2e.invalid`, role: 'user', is_verified: true, supabaseId: csid },
  });
  customer = { user: c, h: bearer(csid) };
});

afterAll(async () => { await prisma.$disconnect(); });
// reset() zeroes the fake's id counter, which would re-issue order ids that already
// exist in the (persistent) DB and trip the unique index; keep ids increasing.
beforeEach(() => { const seq = razorpayFake.seq; razorpayFake.reset(); razorpayFake.seq = seq; });

describe('1. plan seed', () => {
  it('should_return_only_the_gold_Keplix_Partner_plan_at_999_and_deactivate_old_silver_platinum_rows', async () => {
    // Old seed: three plans. ensurePlansSeeded must retire silver/platinum.
    const old = (code, name, price, sort) => prisma.subscriptionPlan.create({
      data: { code, name, monthly_price: price, yearly_price: price * 10, features: [], sort_order: sort },
    });
    await old('silver', 'Silver', 499, 0);
    await old('gold', 'Gold', 999, 1);
    await old('platinum', 'Platinum', 1999, 2);
    __resetPlanSeedCache();

    const res = await request(app).get('/subscriptions/plans');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ code: 'gold', name: 'Keplix Partner', monthly_price: 999 });

    const rows = await prisma.subscriptionPlan.findMany({ orderBy: { code: 'asc' } });
    const active = Object.fromEntries(rows.map((r) => [r.code, r.is_active]));
    expect(active).toEqual({ gold: true, platinum: false, silver: false });
  });
});

describe('2. approval starts the trial and lists the garage', () => {
  let v;
  it('should_reject_approval_of_a_vendor_with_incomplete_onboarding', async () => {
    const incomplete = await makeVendor({ complete: false });
    const res = await approve(incomplete);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ONBOARDING_INCOMPLETE');
  });

  it('should_create_a_90_day_gold_trial_row_when_admin_approves', async () => {
    v = await makeVendor();
    expect(await subRow(v)).toBeNull();
    const res = await approve(v);
    expect(res.status).toBe(200);
    const sub = await subRow(v);
    expect(sub).toMatchObject({ plan_code: 'gold', period: 'trial' });
    expect(near(sub.ends_at, Date.now() + TRIAL_DAYS * DAY)).toBe(true);
    const me = await request(app).get('/subscriptions/me').set(v.h);
    expect(me.body).toMatchObject({ status: 'trial', plan_name: 'Keplix Partner' });
  });

  it('should_show_the_approved_trial_garage_in_customer_search_and_slots', async () => {
    expect(await search(v)).toBe(true);
    expect((await slots(v)).status).toBe(200);
  });
});

describe('3. order', () => {
  let v;
  beforeAll(async () => { v = await makeVendor(); await approve(v); });

  it('should_create_a_99900_paise_order_for_gold_monthly', async () => {
    const res = await orderFor(v);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ amount: 99900, currency: 'INR', plan_code: 'gold', period: 'monthly' });
    const pay = await prisma.subscriptionPayment.findUnique({ where: { razorpay_order_id: res.body.order_id } });
    expect(pay).toMatchObject({ status: 'created', vendorId: v.user.id });
    expect(Number(pay.amount)).toBe(999);
  });

  it('should_ignore_a_client_supplied_amount', async () => {
    const res = await request(app).post('/subscriptions/order').set(v.h).send({ plan_code: 'gold', period: 'monthly', amount: 1 });
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(99900);
  });

  it('should_return_400_for_yearly', async () => {
    const res = await request(app).post('/subscriptions/order').set(v.h).send({ plan_code: 'gold', period: 'yearly' });
    expect(res.status).toBe(400);
  });

  it('should_return_400_for_silver', async () => {
    const res = await request(app).post('/subscriptions/order').set(v.h).send({ plan_code: 'silver', period: 'monthly' });
    expect(res.status).toBe(400);
  });
});

describe('4. verify', () => {
  let v; let trialEnd; let order; let afterFirst;
  beforeAll(async () => { v = await makeVendor(); await approve(v); trialEnd = (await subRow(v)).ends_at; });

  it('should_return_400_and_activate_nothing_for_an_invalid_signature', async () => {
    const bad = (await orderFor(v)).body;
    razorpayFake.seedCapturedPayment({ paymentId: 'pay_bad1', orderId: bad.order_id, amountPaise: bad.amount });
    const res = await request(app).post('/subscriptions/verify').set(v.h).send({
      razorpay_order_id: bad.order_id, razorpay_payment_id: 'pay_bad1', razorpay_signature: 'deadbeef',
    });
    expect(res.status).toBe(400);
    const pay = await prisma.subscriptionPayment.findUnique({ where: { razorpay_order_id: bad.order_id } });
    expect(pay.status).toBe('created');
    expect(ms((await subRow(v)).ends_at)).toBe(ms(trialEnd));
  });

  it('should_extend_from_the_trial_end_by_30_days_and_record_a_paid_payment', async () => {
    order = (await orderFor(v)).body;
    const res = await payAndVerify(v, order, 'pay_ok1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'active', period: 'monthly', plan_code: 'gold' });
    afterFirst = await subRow(v);
    // Documented rule (util/subscription.js computeRenewal): new period is added on top of max(now, ends_at).
    expect(ms(afterFirst.ends_at)).toBe(ms(trialEnd) + 30 * DAY);
    const pay = await prisma.subscriptionPayment.findUnique({ where: { razorpay_order_id: order.order_id } });
    expect(pay).toMatchObject({ status: 'paid', razorpay_payment_id: 'pay_ok1' });
  });

  it('should_not_extend_again_when_verify_is_replayed', async () => {
    const res = await payAndVerify(v, order, 'pay_ok1');
    expect(res.status).toBe(200);
    expect(ms((await subRow(v)).ends_at)).toBe(ms(afterFirst.ends_at));
  });

  it('should_return_404_when_another_vendor_verifies_this_order', async () => {
    const other = await makeVendor(); await approve(other);
    const res = await payAndVerify(other, order, 'pay_ok1');
    expect(res.status).toBe(404);
  });

  it('should_return_400_when_the_gateway_amount_does_not_match', async () => {
    const o2 = (await orderFor(v)).body;
    razorpayFake.seedCapturedPayment({ paymentId: 'pay_short', orderId: o2.order_id, amountPaise: 100 });
    const res = await request(app).post('/subscriptions/verify').set(v.h).send({
      razorpay_order_id: o2.order_id, razorpay_payment_id: 'pay_short',
      razorpay_signature: paymentSignature(o2.order_id, 'pay_short'),
    });
    expect(res.status).toBe(400);
    expect((await prisma.subscriptionPayment.findUnique({ where: { razorpay_order_id: o2.order_id } })).status).toBe('created');
  });
});

describe('5. webhook', () => {
  let v; let order; let afterFirst;
  const send = (w) => request(app).post('/service_api/payments/razorpay-webhook').set(w.headers).send(w.body);
  const hook = (eventId) => {
    const w = capturedPaymentWebhook({ paymentId: 'pay_wh1', orderId: order.order_id, amountPaise: order.amount, eventId });
    // Subscription orders are recognised by notes.type, so inject it and re-sign the exact bytes.
    const parsed = JSON.parse(w.body);
    parsed.payload.payment.entity.notes = { type: 'subscription', vendorId: String(v.user.id) };
    const body = JSON.stringify(parsed);
    const signature = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
    return { body, headers: { ...w.headers, 'x-razorpay-signature': signature } };
  };
  beforeAll(async () => { v = await makeVendor(); await approve(v); order = (await orderFor(v)).body; });

  it('should_reject_a_webhook_with_a_bad_signature', async () => {
    const w = hook('evt_bad');
    const res = await send({ ...w, headers: { ...w.headers, 'x-razorpay-signature': '00' } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await prisma.subscriptionPayment.findUnique({ where: { razorpay_order_id: order.order_id } })).status).toBe('created');
  });

  it('should_activate_the_subscription_from_payment_captured_without_verify', async () => {
    const before = await subRow(v);
    const res = await send(hook('evt_wh_1'));
    expect(res.status).toBe(200);
    afterFirst = await subRow(v);
    expect(afterFirst.period).toBe('monthly');
    expect(ms(afterFirst.ends_at)).toBe(ms(before.ends_at) + 30 * DAY);
    expect((await prisma.subscriptionPayment.findUnique({ where: { razorpay_order_id: order.order_id } })).status).toBe('paid');
  });

  it('should_ignore_a_duplicate_webhook_delivery_with_the_same_event_id', async () => {
    const res = await send(hook('evt_wh_1'));
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(ms((await subRow(v)).ends_at)).toBe(ms(afterFirst.ends_at));
  });

  it('should_not_double_extend_when_the_same_payment_arrives_under_a_new_event_id', async () => {
    const res = await send(hook('evt_wh_2'));
    expect(res.status).toBe(200);
    expect(ms((await subRow(v)).ends_at)).toBe(ms(afterFirst.ends_at));
  });

  it('should_not_double_extend_when_verify_runs_after_the_webhook', async () => {
    const res = await payAndVerify(v, order, 'pay_wh1');
    expect(res.status).toBe(200);
    expect(ms((await subRow(v)).ends_at)).toBe(ms(afterFirst.ends_at));
  });
});

describe('6. expiry, grace and renewal', () => {
  let v;
  const setEnds = (offset) => prisma.vendorSubscription.update({
    where: { vendorId: v.user.id },
    data: { ends_at: new Date(Date.now() + offset), starts_at: new Date(Date.now() + offset - 30 * DAY) },
  });
  beforeAll(async () => { v = await makeVendor(); await approve(v); });

  it('should_report_grace_and_stay_visible_one_day_past_the_end_date', async () => {
    await setEnds(-1 * DAY);
    const me = await request(app).get('/subscriptions/me').set(v.h);
    expect(me.body.status).toBe('grace');
    expect(await search(v)).toBe(true);
    expect((await slots(v)).status).toBe(200);
  });

  it('should_hide_the_garage_and_return_GARAGE_UNAVAILABLE_past_the_7_day_grace', async () => {
    await setEnds(-8 * DAY);
    const me = await request(app).get('/subscriptions/me').set(v.h);
    expect(me.body.status).toBe('expired');
    expect(await search(v)).toBe(false);
    const res = await slots(v);
    expect(res.status).toBe(403);
    expect(res.body.code ?? res.body.error?.code).toBe('GARAGE_UNAVAILABLE');
  });

  it('should_restore_visibility_and_start_the_new_period_from_now_after_paying_again', async () => {
    const order = (await orderFor(v)).body;
    const res = await payAndVerify(v, order, 'pay_renew1');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(near((await subRow(v)).ends_at, Date.now() + 30 * DAY)).toBe(true);
    expect(await search(v)).toBe(true);
    expect((await slots(v)).status).toBe(200);
  });
});

describe('7. admin extend', () => {
  let v;
  beforeAll(async () => { v = await makeVendor(); await approve(v); });

  it('should_add_days_to_the_end_date', async () => {
    const before = await subRow(v);
    const res = await request(app).post(`/admin/subscriptions/vendors/${v.user.id}/extend`).set(admin.h).send({ days: 15, reason: 'goodwill' });
    expect(res.status).toBe(200);
    expect(ms((await subRow(v)).ends_at)).toBe(ms(before.ends_at) + 15 * DAY);
  });

  it('should_forbid_a_vendor_from_extending', async () => {
    const res = await request(app).post(`/admin/subscriptions/vendors/${v.user.id}/extend`).set(v.h).send({ days: 15, reason: 'self serve' });
    expect([401, 403]).toContain(res.status);
  });
});
