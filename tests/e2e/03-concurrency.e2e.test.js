import { jest } from '@jest/globals';

/**
 * TIER 3 — CONCURRENCY
 *
 * The tests that actually matter for money. Each fires N genuinely
 * simultaneous requests at the same row and asserts a hard post-condition.
 *
 * Two things are asserted separately and deliberately:
 *   - the DATABASE end state (one payment, one settlement, correct totals)
 *   - the number of times the GATEWAY was called
 * They can disagree. A double payout can leave a perfectly tidy database while
 * having moved the money twice, so counting gateway calls is the only way to
 * catch it.
 *
 * These run against the live database by explicit decision, so every test
 * builds its own isolated fixtures and everything is torn down in afterAll.
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
const { processPayoutJob } = await import('../../workers/payoutProcessor.js');
const {
  createCustomer, createVendor, createAdmin, createService, createBooking,
  createSuccessfulPayment, givePayoutAccount, setSuiteTag, cleanupTestData, cleanupWebhookEvents, TEST_TAG,
} = await import('./helpers/fixtures.js');

// Claim a suite-scoped tag so this file's cleanup can never delete fixtures
// belonging to a sibling suite running in a parallel jest worker.
setSuiteTag('conc');
const { paymentSignature, capturedPaymentWebhook } = await import('./helpers/razorpay.js');

const PRICE = 5000;
const PARALLEL = 8;

let customer, vendor, admin, service;

beforeAll(async () => {
  customer = await createCustomer();
  vendor = await createVendor();
  admin = await createAdmin();
  await givePayoutAccount(vendor.user.id);
  service = await createService(vendor.user.id, PRICE);
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

/** Fails the test if any response was a rate-limit rejection rather than a real result. */
const assertNoRateLimiting = (responses) => {
  const limited = responses.filter((r) => r.status === 429);
  if (limited.length) {
    throw new Error(
      `${limited.length}/${responses.length} requests were rate-limited (429). ` +
      `The concurrency guard under test was never exercised — results are meaningless.`,
    );
  }
};

describe('Tier 3 — concurrent payment verification', () => {
  test(`${PARALLEL} simultaneous /verify calls produce exactly one successful payment`, async () => {
    const booking = await createBooking(customer.user.id, service.id);
    const orderId = `order_${TEST_TAG}_v${Date.now()}`;
    const paymentId = `pay_${TEST_TAG}_v${Date.now()}`;
    razorpayFake.seedCapturedPayment({ paymentId, orderId, amountPaise: PRICE * 100 });

    const body = {
      bookingId: booking.id,
      orderId,
      paymentId,
      signature: paymentSignature(orderId, paymentId),
      gateway: 'razorpay',
    };

    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        request(app)
          .post('/service_api/payments/verify')
          .set('Authorization', `Bearer ${customer.token}`)
          .send(body),
      ),
    );

    assertNoRateLimiting(responses);

    // Exactly one payment row, in success, at the full server-derived price.
    const payments = await prisma.payment.findMany({ where: { bookingId: booking.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('success');
    expect(Number(payments[0].amount)).toBe(PRICE);

    // No request may have leaked a 500: a P2002 from the unique constraint is
    // the DB doing its job, but it must be handled, not surfaced as a crash.
    const serverErrors = responses.filter((r) => r.status >= 500);
    expect(serverErrors.map((r) => r.body)).toEqual([]);

    // At least one caller must have been told it succeeded.
    expect(responses.some((r) => r.status === 200)).toBe(true);
  }, 60000);

  test('re-verifying an already-settled payment never re-arms the payout', async () => {
    const booking = await createBooking(customer.user.id, service.id);
    const orderId = `order_${TEST_TAG}_s${Date.now()}`;
    const paymentId = `pay_${TEST_TAG}_s${Date.now()}`;
    razorpayFake.seedCapturedPayment({ paymentId, orderId, amountPaise: PRICE * 100 });

    // A payment that has already been paid out to the vendor.
    await createSuccessfulPayment(booking.id, PRICE, {
      transactionId: paymentId,
      vendorPayoutStatus: 'paid',
      vendorPayoutId: 'pout_already_done',
    });

    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        request(app)
          .post('/service_api/payments/verify')
          .set('Authorization', `Bearer ${customer.token}`)
          .send({
            bookingId: booking.id,
            orderId,
            paymentId,
            signature: paymentSignature(orderId, paymentId),
            gateway: 'razorpay',
          }),
      ),
    );

    assertNoRateLimiting(responses);

    const payment = await prisma.payment.findUnique({ where: { bookingId: booking.id } });
    // The single most important assertion in this file: a replayed verify must
    // never knock a settled payout back to "pending", which would make it
    // eligible for a second transfer.
    expect(payment.vendorPayoutStatus).toBe('paid');
    expect(payment.vendorPayoutId).toBe('pout_already_done');
  }, 60000);
});

describe('Tier 3 — concurrent payout settlement', () => {
  test(`${PARALLEL} simultaneous admin settles enqueue at most one payout job`, async () => {
    const booking = await createBooking(customer.user.id, service.id);
    const payment = await createSuccessfulPayment(booking.id, PRICE);

    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        request(app)
          .post(`/admin/finance/payouts/${payment.id}/settle`)
          .set('Authorization', `Bearer ${admin.token}`),
      ),
    );

    assertNoRateLimiting(responses);

    const accepted = responses.filter((r) => r.status === 202);
    expect(accepted).toHaveLength(1);
    expect(mockAddPayoutJob).toHaveBeenCalledTimes(1);

    const after = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(after.vendorPayoutStatus).toBe('processing');
  }, 60000);

  test('the two independent enqueue paths (admin settle + customer confirmation) cannot both claim one payment', async () => {
    // bookingConfirmationService and payoutService are separate code paths that
    // both flip vendorPayoutStatus and enqueue. Racing them must still yield
    // one claim.
    const booking = await createBooking(customer.user.id, service.id, { status: 'service_completed' });
    const payment = await createSuccessfulPayment(booking.id, PRICE);

    const [settle, confirm] = await Promise.all([
      request(app)
        .post(`/admin/finance/payouts/${payment.id}/settle`)
        .set('Authorization', `Bearer ${admin.token}`),
      request(app)
        .post(`/service_api/user/${customer.user.id}/bookings/${booking.id}/confirm`)
        .set('Authorization', `Bearer ${customer.token}`)
        .send({ confirmed: true }),
    ]);

    assertNoRateLimiting([settle, confirm]);

    // Whichever won, the payout must have been enqueued exactly once.
    expect(mockAddPayoutJob).toHaveBeenCalledTimes(1);

    const after = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(['processing', 'paid']).toContain(after.vendorPayoutStatus);
  }, 60000);

  test('duplicate payout JOBS for one payment call the gateway exactly once', async () => {
    const booking = await createBooking(customer.user.id, service.id);
    const payment = await createSuccessfulPayment(booking.id, PRICE, { vendorPayoutStatus: 'processing' });

    const job = { data: { paymentId: payment.id, vendorId: vendor.user.id, bookingId: booking.id } };

    // Five workers picking up the same job simultaneously — the scenario the
    // PayoutSettlement ledger exists to survive. Some may reject with P2002
    // from the unique constraint; what must NOT happen is two transfers.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => processPayoutJob(job)),
    );

    expect(razorpayFake.calls.payoutsCreate).toHaveLength(1);

    const settlement = await prisma.payoutSettlement.findUnique({ where: { paymentId: payment.id } });
    expect(settlement).not.toBeNull();
    expect(['gateway_confirmed', 'settled']).toContain(settlement.status);

    const after = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(after.vendorPayoutStatus).toBe('paid');

    // Surface unexpected rejections rather than silently tolerating them.
    const unexpected = results
      .filter((r) => r.status === 'rejected')
      .filter((r) => !/Unique constraint|P2002/i.test(String(r.reason?.message)));
    expect(unexpected.map((r) => String(r.reason?.message))).toEqual([]);
  }, 60000);
});

describe('Tier 3 — concurrent webhooks', () => {
  test('the same webhook delivered many times in parallel is processed once', async () => {
    const booking = await createBooking(customer.user.id, service.id);
    const eventId = `${TEST_TAG}-conc-${Date.now()}`;
    const { body, headers } = capturedPaymentWebhook({
      paymentId: `pay_${TEST_TAG}_wc${Date.now()}`,
      orderId: `order_${TEST_TAG}_wc`,
      amountPaise: PRICE * 100,
      bookingId: booking.id,
      eventId,
    });

    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        request(app).post('/service_api/payments/razorpay-webhook').set(headers).send(body),
      ),
    );

    assertNoRateLimiting(responses);

    const events = await prisma.webhookEvent.findMany({ where: { eventId } });
    expect(events).toHaveLength(1);

    const payments = await prisma.payment.findMany({ where: { bookingId: booking.id } });
    expect(payments).toHaveLength(1);
  }, 60000);
});

describe('Tier 3 — concurrent refunds (the over-refund race)', () => {
  test('two parallel partial refunds with different keys can never exceed the payment total', async () => {
    // Each request asks for 60% of a payment. Individually both are valid;
    // together they are 120% of the money that was ever collected. Before the
    // fix, the balance check read a stale total and both were approved.
    const booking = await createBooking(customer.user.id, service.id);
    const payment = await createSuccessfulPayment(booking.id, PRICE);
    const each = PRICE * 0.6;

    const responses = await Promise.all([
      request(app)
        .post(`/admin/finance/payments/${payment.id}/refund`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ amount: each, idempotencyKey: `${TEST_TAG}-race-a-${payment.id}` }),
      request(app)
        .post(`/admin/finance/payments/${payment.id}/refund`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ amount: each, idempotencyKey: `${TEST_TAG}-race-b-${payment.id}` }),
    ]);

    assertNoRateLimiting(responses);

    const refunds = await prisma.refund.findMany({
      where: { paymentId: payment.id, status: { not: 'gateway_failed' } },
    });
    const totalRefunded = refunds.reduce((sum, r) => sum + Number(r.amount), 0);

    expect(totalRefunded).toBeLessThanOrEqual(PRICE);
    // And the gateway must not have been asked to move more than was collected.
    const gatewayTotalPaise = razorpayFake.calls.paymentsRefund
      .reduce((sum, c) => sum + c.params.amount, 0);
    expect(gatewayTotalPaise).toBeLessThanOrEqual(PRICE * 100);

    // Exactly one should have succeeded; the other must have been rejected.
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
  }, 60000);

  test('replaying the same refund key in parallel refunds the money only once', async () => {
    const booking = await createBooking(customer.user.id, service.id);
    const payment = await createSuccessfulPayment(booking.id, PRICE);
    const key = `${TEST_TAG}-idem-${payment.id}`;

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app)
          .post(`/admin/finance/payments/${payment.id}/refund`)
          .set('Authorization', `Bearer ${admin.token}`)
          .send({ amount: 1000, idempotencyKey: key }),
      ),
    );

    assertNoRateLimiting(responses);

    const refunds = await prisma.refund.findMany({ where: { idempotencyKey: key } });
    expect(refunds).toHaveLength(1);
    expect(razorpayFake.calls.paymentsRefund).toHaveLength(1);
  }, 60000);
});
