import { jest } from '@jest/globals';
import crypto from 'node:crypto';

/**
 * TIER 2 — ADVERSARIAL
 *
 * Every exploit from the payment audit, replayed as real HTTP traffic against
 * the real Express app (middleware, validators, controllers and all) rather
 * than against a service function in isolation. A unit test can prove a
 * function rejects bad input; only this proves the route actually reaches that
 * function with the protections wired up.
 *
 * ## The 429 rule
 *
 * The app applies a global limiter (1000 req / 15 min) and, on auth routes, a
 * strict one (3 per 2 hours). A test that expects 403 and receives 429 has
 * PASSED FOR THE WRONG REASON — the request was rejected by a rate limiter,
 * not by the security control being tested. `expectRejected` below fails
 * loudly on 429 for exactly that reason.
 */

process.env.RAZORPAY_KEY_SECRET = 'e2e_test_key_secret';
process.env.RAZORPAY_KEY_ID = 'rzp_test_e2e';
process.env.RAZORPAY_WEBHOOK_SECRET = 'e2e_test_webhook_secret';

const { redisFake } = await import('./helpers/redisFake.js');
jest.unstable_mockModule('../../util/redis.js', () => ({ default: redisFake }));

const { razorpayFake } = await import('./helpers/razorpay.js');
jest.unstable_mockModule('razorpay', () => ({
  default: jest.fn().mockImplementation(() => razorpayFake),
}));

// Every BullMQ queue must be mocked, not just the payout one. A Queue is
// constructed at module load and opens a real Redis connection, which with a
// faked Redis client never resolves — the suite hangs rather than failing.
// notificationQueue is reachable from app.js transitively via
// controllers/user/bookingController.js, so it has to be stubbed even though
// no test here touches notifications.
const mockAddPayoutJob = jest.fn();
jest.unstable_mockModule('../../queues/payoutQueue.js', () => ({
  addPayoutJob: mockAddPayoutJob,
  default: {},
}));

const mockAddNotificationJob = jest.fn();
jest.unstable_mockModule('../../queues/notificationQueue.js', () => ({
  addNotificationJob: mockAddNotificationJob,
  default: {},
}));

const request = (await import('supertest')).default;
const app = (await import('../../app.js')).default;
const prisma = (await import('../../util/prisma.js')).default;
const {
  createCustomer, createVendor, createAdmin, createService, createBooking,
  createSuccessfulPayment, setSuiteTag, cleanupTestData, cleanupWebhookEvents, TEST_TAG,
} = await import('./helpers/fixtures.js');

// Claim a suite-scoped tag so this file's cleanup can never delete fixtures
// belonging to a sibling suite running in a parallel jest worker.
setSuiteTag('adv');
const { paymentSignature, capturedPaymentWebhook } = await import('./helpers/razorpay.js');

const PRICE = 5000;

let customer, otherCustomer, vendor, admin, service, booking;

/**
 * Asserts a request was rejected by the application's own guard, not by a
 * rate limiter or an unhandled crash.
 */
function expectRejected(res, allowedStatuses) {
  if (res.status === 429) {
    throw new Error(
      `Request was rate-limited (429), not rejected by the security control under test. ` +
      `This test would have passed for the wrong reason. Re-run against a fresh limiter window.`,
    );
  }
  if (res.status >= 500) {
    throw new Error(`Expected a 4xx rejection but the server errored (${res.status}): ${JSON.stringify(res.body)}`);
  }
  expect(allowedStatuses).toContain(res.status);
}

beforeAll(async () => {
  customer = await createCustomer();
  otherCustomer = await createCustomer();
  vendor = await createVendor();
  admin = await createAdmin();
  service = await createService(vendor.user.id, PRICE);
  booking = await createBooking(customer.user.id, service.id);
}, 60000);

afterAll(async () => {
  await cleanupWebhookEvents();
  await cleanupTestData();
  await prisma.$disconnect();
}, 60000);

beforeEach(() => {
  razorpayFake.reset();
  mockAddPayoutJob.mockClear();
});

describe('Tier 2 — adversarial: payment verification', () => {
  test('a self-reported non-online gateway cannot confirm a booking (free-booking exploit)', async () => {
    // The original exploit: POST /verify {bookingId, gateway:"upi"} skipped
    // signature verification entirely and recorded a full-price payment.
    for (const gateway of ['upi', 'cash', 'card', 'netbanking']) {
      const res = await request(app)
        .post('/service_api/payments/verify')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({ bookingId: booking.id, gateway });

      expectRejected(res, [400, 403]);
    }

    const payment = await prisma.payment.findUnique({ where: { bookingId: booking.id } });
    expect(payment).toBeNull();
  });

  test('a forged signature is rejected', async () => {
    razorpayFake.seedCapturedPayment({ paymentId: 'pay_forge', orderId: 'order_forge', amountPaise: PRICE * 100 });

    const res = await request(app)
      .post('/service_api/payments/verify')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({
        bookingId: booking.id,
        orderId: 'order_forge',
        paymentId: 'pay_forge',
        signature: 'definitely-not-a-real-signature',
        gateway: 'razorpay',
      });

    expectRejected(res, [400]);
    expect(razorpayFake.calls.paymentsFetch).toHaveLength(0);
  });

  test('a valid signature over an UNCAPTURED payment is rejected', async () => {
    // A signature only proves Razorpay produced the pair — not that money moved.
    razorpayFake.seedCapturedPayment({
      paymentId: 'pay_authorized', orderId: 'order_authorized', amountPaise: PRICE * 100, status: 'authorized',
    });

    const res = await request(app)
      .post('/service_api/payments/verify')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({
        bookingId: booking.id,
        orderId: 'order_authorized',
        paymentId: 'pay_authorized',
        signature: paymentSignature('order_authorized', 'pay_authorized'),
        gateway: 'razorpay',
      });

    expectRejected(res, [400]);
  });

  test('a captured payment for LESS than the booking price is rejected', async () => {
    // The ₹1-for-a-₹5000-booking exploit.
    razorpayFake.seedCapturedPayment({ paymentId: 'pay_cheap', orderId: 'order_cheap', amountPaise: 100 });

    const res = await request(app)
      .post('/service_api/payments/verify')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({
        bookingId: booking.id,
        orderId: 'order_cheap',
        paymentId: 'pay_cheap',
        signature: paymentSignature('order_cheap', 'pay_cheap'),
        gateway: 'razorpay',
      });

    expectRejected(res, [400]);
  });

  test('a captured payment belonging to a DIFFERENT order is rejected', async () => {
    razorpayFake.seedCapturedPayment({ paymentId: 'pay_x', orderId: 'order_actual', amountPaise: PRICE * 100 });

    const res = await request(app)
      .post('/service_api/payments/verify')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({
        bookingId: booking.id,
        orderId: 'order_claimed', // not the order the payment belongs to
        paymentId: 'pay_x',
        signature: paymentSignature('order_claimed', 'pay_x'),
        gateway: 'razorpay',
      });

    expectRejected(res, [400]);
  });

  test('a user cannot confirm someone else\'s booking even with a valid signature', async () => {
    razorpayFake.seedCapturedPayment({ paymentId: 'pay_cross', orderId: 'order_cross', amountPaise: PRICE * 100 });

    const res = await request(app)
      .post('/service_api/payments/verify')
      .set('Authorization', `Bearer ${otherCustomer.token}`) // not the booking owner
      .send({
        bookingId: booking.id,
        orderId: 'order_cross',
        paymentId: 'pay_cross',
        signature: paymentSignature('order_cross', 'pay_cross'),
        gateway: 'razorpay',
      });

    expectRejected(res, [403]);
  });

  test('unauthenticated verify is rejected', async () => {
    const res = await request(app)
      .post('/service_api/payments/verify')
      .send({ bookingId: booking.id, gateway: 'razorpay' });

    expectRejected(res, [401]);
  });
});

describe('Tier 2 — adversarial: order creation', () => {
  test('a client-supplied amount is ignored; the order is priced from the service', async () => {
    const res = await request(app)
      .post('/service_api/payments/order/create')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ bookingId: booking.id, amount: 1 }); // attacker-chosen

    expect(res.status).toBe(200);
    // The gateway must have been asked for the real price, in paise.
    expect(razorpayFake.calls.ordersCreate).toHaveLength(1);
    expect(razorpayFake.calls.ordersCreate[0].params.amount).toBe(PRICE * 100);
  });

  test('a user cannot create an order against someone else\'s booking', async () => {
    const res = await request(app)
      .post('/service_api/payments/order/create')
      .set('Authorization', `Bearer ${otherCustomer.token}`)
      .send({ bookingId: booking.id });

    expectRejected(res, [403]);
    expect(razorpayFake.calls.ordersCreate).toHaveLength(0);
  });
});

describe('Tier 2 — adversarial: webhooks', () => {
  test('an unsigned webhook is rejected', async () => {
    const res = await request(app)
      .post('/service_api/payments/razorpay-webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ event: 'payment.captured', payload: {} }));

    expectRejected(res, [400]);
  });

  test('a webhook signed with the WRONG secret is rejected', async () => {
    const body = JSON.stringify({ event: 'payment.captured', payload: {}, created_at: 1 });
    const badSignature = crypto.createHmac('sha256', 'not-the-secret').update(body).digest('hex');

    const res = await request(app)
      .post('/service_api/payments/razorpay-webhook')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', badSignature)
      .send(body);

    expectRejected(res, [400]);
  });

  test('a correctly signed webhook is accepted, and replaying it is a no-op', async () => {
    const b = await createBooking(customer.user.id, service.id);
    const eventId = `${TEST_TAG}-replay-${Date.now()}`;
    const { body, headers } = capturedPaymentWebhook({
      paymentId: `pay_${TEST_TAG}_wh_${Date.now()}`,
      orderId: 'order_wh',
      amountPaise: PRICE * 100,
      bookingId: b.id,
      eventId,
    });

    const first = await request(app)
      .post('/service_api/payments/razorpay-webhook')
      .set(headers)
      .send(body);
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBeUndefined();

    const second = await request(app)
      .post('/service_api/payments/razorpay-webhook')
      .set(headers)
      .send(body);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    const events = await prisma.webhookEvent.findMany({ where: { eventId } });
    expect(events).toHaveLength(1);
  });
});

describe('Tier 2 — adversarial: admin-only routes', () => {
  test('a customer token cannot settle a payout', async () => {
    const b = await createBooking(customer.user.id, service.id);
    const payment = await createSuccessfulPayment(b.id, PRICE);

    const res = await request(app)
      .post(`/admin/finance/payouts/${payment.id}/settle`)
      .set('Authorization', `Bearer ${customer.token}`);

    expectRejected(res, [401, 403]);
    expect(mockAddPayoutJob).not.toHaveBeenCalled();
  });

  test('a customer token cannot issue a refund', async () => {
    const b = await createBooking(customer.user.id, service.id);
    const payment = await createSuccessfulPayment(b.id, PRICE);

    const res = await request(app)
      .post(`/admin/finance/payments/${payment.id}/refund`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ idempotencyKey: `${TEST_TAG}-should-not-work`, amount: PRICE });

    expectRejected(res, [401, 403]);
    expect(razorpayFake.calls.paymentsRefund).toHaveLength(0);
  });

  test('an admin CAN settle — proving the rejections above are about authorisation, not a broken route', async () => {
    const b = await createBooking(customer.user.id, service.id);
    const payment = await createSuccessfulPayment(b.id, PRICE);

    const res = await request(app)
      .post(`/admin/finance/payouts/${payment.id}/settle`)
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.status).toBe(202);
    expect(mockAddPayoutJob).toHaveBeenCalledTimes(1);
  });

  test('a refund without an idempotencyKey is rejected', async () => {
    const b = await createBooking(customer.user.id, service.id);
    const payment = await createSuccessfulPayment(b.id, PRICE);

    const res = await request(app)
      .post(`/admin/finance/payments/${payment.id}/refund`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ amount: 100 });

    expectRejected(res, [400]);
    expect(razorpayFake.calls.paymentsRefund).toHaveLength(0);
  });
});
