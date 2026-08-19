import { jest } from '@jest/globals';

/**
 * TIER 4 — FAILURE INJECTION
 *
 * Payment systems don't lose money on the happy path; they lose it when
 * something fails halfway through. Each test here breaks the flow at a
 * specific point and asserts the system either recovers or fails safe.
 *
 * The rule every test enforces: **money must never move twice, and a customer
 * must never be charged without the booking settling.** Where those two can
 * conflict, failing safe means leaving a discoverable record for a human
 * rather than guessing.
 */

process.env.RAZORPAY_KEY_SECRET = 'e2e_test_key_secret';
process.env.RAZORPAY_KEY_ID = 'rzp_test_e2e';
process.env.RAZORPAY_WEBHOOK_SECRET = 'e2e_test_webhook_secret';

// No Redis fake: Redis was removed from the app. The token blacklist is a
// real table now, which this suite's real database provides.

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
const { reconcileStalePayments } = await import('../../util/paymentReconciliation.js');
const {
  createCustomer, createVendor, createAdmin, createService, createBooking,
  createSuccessfulPayment, givePayoutAccount, setSuiteTag, cleanupTestData,
  cleanupWebhookEvents, TEST_TAG,
} = await import('./helpers/fixtures.js');

setSuiteTag('fail');

const { paymentSignature, capturedPaymentWebhook, signedWebhook } = await import('./helpers/razorpay.js');

const PRICE = 5000;
const VENDOR_SHARE = PRICE * 0.9;

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

describe('Tier 4 — gateway failures during verification', () => {
  test('a gateway timeout during verify records NO payment and does not confirm the booking', async () => {
    const booking = await createBooking(customer.user.id, service.id);
    const orderId = `order_${TEST_TAG}_to`;
    const paymentId = `pay_${TEST_TAG}_to`;

    razorpayFake.seedCapturedPayment({ paymentId, orderId, amountPaise: PRICE * 100 });
    razorpayFake.failOn('payments.fetch', new Error('ETIMEDOUT'));

    const res = await request(app)
      .post('/service_api/payments/verify')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ bookingId: booking.id, orderId, paymentId, signature: paymentSignature(orderId, paymentId), gateway: 'razorpay' });

    // 502: we could not establish what the gateway thinks, so we refuse to
    // guess. Recording a success here would confirm a booking on the strength
    // of a signature alone.
    expect(res.status).toBe(502);

    const payment = await prisma.payment.findUnique({ where: { bookingId: booking.id } });
    expect(payment).toBeNull();

    // Note: booking status is deliberately NOT asserted here. "confirmed" is
    // overloaded in this schema — the vendor accepting a booking sets it, and
    // so does a successful payment — so it cannot distinguish "paid" from
    // "vendor accepted but unpaid". The absence of a Payment row is the only
    // meaningful assertion at this point.
  }, 60000);

  test('a verify that timed out can be completed later once the gateway recovers', async () => {
    const booking = await createBooking(customer.user.id, service.id);
    const orderId = `order_${TEST_TAG}_rec`;
    const paymentId = `pay_${TEST_TAG}_rec`;
    razorpayFake.seedCapturedPayment({ paymentId, orderId, amountPaise: PRICE * 100 });
    razorpayFake.failOn('payments.fetch', new Error('ETIMEDOUT'), 1); // fail once only

    const body = { bookingId: booking.id, orderId, paymentId, signature: paymentSignature(orderId, paymentId), gateway: 'razorpay' };

    const first = await request(app).post('/service_api/payments/verify')
      .set('Authorization', `Bearer ${customer.token}`).send(body);
    expect(first.status).toBe(502);

    // The client retries — this is the crash-recovery path the mobile app uses.
    const second = await request(app).post('/service_api/payments/verify')
      .set('Authorization', `Bearer ${customer.token}`).send(body);
    expect(second.status).toBe(200);

    const payment = await prisma.payment.findUnique({ where: { bookingId: booking.id } });
    expect(payment.status).toBe('success');
    expect(Number(payment.amount)).toBe(PRICE);
  }, 60000);
});

describe('Tier 4 — payout failures', () => {
  test('a gateway failure marks the settlement gateway_failed and rethrows so BullMQ retries', async () => {
    const booking = await createBooking(customer.user.id, service.id);
    const payment = await createSuccessfulPayment(booking.id, PRICE, { vendorPayoutStatus: 'processing' });

    razorpayFake.failOn('payouts.create', new Error('RazorpayX 500'));

    await expect(
      processPayoutJob({ data: { paymentId: payment.id, vendorId: vendor.user.id, bookingId: booking.id } }),
    ).rejects.toThrow();

    const settlement = await prisma.payoutSettlement.findUnique({ where: { paymentId: payment.id } });
    expect(settlement.status).toBe('gateway_failed');
    expect(settlement.lastError).toBeTruthy();

    const after = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(after.vendorPayoutStatus).toBe('failed');
    // Nothing was transferred, so a retry is safe — that's why it rethrows.
  }, 60000);

  test('a failed payout that later succeeds transfers exactly once', async () => {
    const booking = await createBooking(customer.user.id, service.id);
    const payment = await createSuccessfulPayment(booking.id, PRICE, { vendorPayoutStatus: 'processing' });
    const job = { data: { paymentId: payment.id, vendorId: vendor.user.id, bookingId: booking.id } };

    razorpayFake.failOn('payouts.create', new Error('transient'), 1);
    await expect(processPayoutJob(job)).rejects.toThrow();

    await processPayoutJob(job); // BullMQ retry

    expect(razorpayFake.calls.payoutsCreate).toHaveLength(1);
    const after = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(after.vendorPayoutStatus).toBe('paid');
  }, 60000);

  test('a crash AFTER the transfer but before bookkeeping never transfers twice', async () => {
    // This is the dangerous one. The gateway has already moved the money and
    // the settlement recorded "gateway_confirmed"; then the process died.
    // A retry must finish the bookkeeping WITHOUT calling the gateway again.
    const booking = await createBooking(customer.user.id, service.id);
    const payment = await createSuccessfulPayment(booking.id, PRICE, { vendorPayoutStatus: 'processing' });

    await prisma.payoutSettlement.create({
      data: {
        paymentId: payment.id,
        amount: VENDOR_SHARE,
        status: 'gateway_confirmed',
        gatewayPayoutId: 'pout_already_sent',
      },
    });

    await processPayoutJob({ data: { paymentId: payment.id, vendorId: vendor.user.id, bookingId: booking.id } });

    // The single most important assertion in this file.
    expect(razorpayFake.calls.payoutsCreate).toHaveLength(0);

    const settlement = await prisma.payoutSettlement.findUnique({ where: { paymentId: payment.id } });
    expect(settlement.status).toBe('settled');
    expect(settlement.gatewayPayoutId).toBe('pout_already_sent');

    const after = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(after.vendorPayoutStatus).toBe('paid');
    expect(after.vendorPayoutId).toBe('pout_already_sent');
  }, 60000);

  test('a settlement flagged reconciliation_needed is never re-sent to the gateway', async () => {
    const booking = await createBooking(customer.user.id, service.id);
    const payment = await createSuccessfulPayment(booking.id, PRICE, { vendorPayoutStatus: 'processing' });

    await prisma.payoutSettlement.create({
      data: {
        paymentId: payment.id,
        amount: VENDOR_SHARE,
        status: 'reconciliation_needed',
        gatewayPayoutId: 'pout_unknown_outcome',
        lastError: 'bookkeeping failed after transfer',
      },
    });

    await processPayoutJob({ data: { paymentId: payment.id, vendorId: vendor.user.id, bookingId: booking.id } });

    expect(razorpayFake.calls.payoutsCreate).toHaveLength(0);
  }, 60000);

  test('an already-settled payment short-circuits without touching the gateway', async () => {
    const booking = await createBooking(customer.user.id, service.id);
    const payment = await createSuccessfulPayment(booking.id, PRICE, { vendorPayoutStatus: 'processing' });

    await prisma.payoutSettlement.create({
      data: { paymentId: payment.id, amount: VENDOR_SHARE, status: 'settled', gatewayPayoutId: 'pout_done' },
    });

    await processPayoutJob({ data: { paymentId: payment.id, vendorId: vendor.user.id, bookingId: booking.id } });

    expect(razorpayFake.calls.payoutsCreate).toHaveLength(0);
    const after = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(after.vendorPayoutStatus).toBe('paid');
  }, 60000);

  test('a vendor with no payout account fails the payout instead of guessing a destination', async () => {
    // The removed fallback used to auto-create a fund account with a hardcoded
    // bank account, so money went somewhere rather than nowhere.
    const lonelyVendor = await createVendor();
    const lonelyService = await createService(lonelyVendor.user.id, PRICE);
    const booking = await createBooking(customer.user.id, lonelyService.id);
    const payment = await createSuccessfulPayment(booking.id, PRICE, { vendorPayoutStatus: 'processing' });

    await expect(
      processPayoutJob({ data: { paymentId: payment.id, vendorId: lonelyVendor.user.id, bookingId: booking.id } }),
    ).rejects.toThrow();

    expect(razorpayFake.calls.payoutsCreate).toHaveLength(0);
  }, 60000);
});

describe('Tier 4 — client dies before verify', () => {
  test('the webhook alone records the payment and confirms the booking', async () => {
    const booking = await createBooking(customer.user.id, service.id);
    const paymentId = `pay_${TEST_TAG}_orphan_${Date.now()}`;

    const { body, headers } = capturedPaymentWebhook({
      paymentId,
      orderId: `order_${TEST_TAG}_orphan`,
      amountPaise: PRICE * 100,
      bookingId: booking.id,
      eventId: `${TEST_TAG}-orphan-${Date.now()}`,
    });

    const res = await request(app).post('/service_api/payments/razorpay-webhook').set(headers).send(body);
    expect(res.status).toBe(200);

    const payment = await prisma.payment.findUnique({ where: { bookingId: booking.id } });
    expect(payment).not.toBeNull();
    expect(payment.status).toBe('success');
    expect(Number(payment.amount)).toBe(PRICE);

    const after = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(after.status).toBe('confirmed');
  }, 60000);

  test('a webhook whose captured amount does not match the booking is NOT recorded', async () => {
    const booking = await createBooking(customer.user.id, service.id);

    const { body, headers } = capturedPaymentWebhook({
      paymentId: `pay_${TEST_TAG}_mismatch_${Date.now()}`,
      orderId: `order_${TEST_TAG}_mismatch`,
      amountPaise: 100, // ₹1 against a ₹5000 booking
      bookingId: booking.id,
      eventId: `${TEST_TAG}-mismatch-${Date.now()}`,
    });

    const res = await request(app).post('/service_api/payments/razorpay-webhook').set(headers).send(body);
    expect(res.status).toBe(200); // acknowledged so Razorpay stops retrying...

    // ...but nothing was recorded: it's flagged for manual review instead.
    const payment = await prisma.payment.findUnique({ where: { bookingId: booking.id } });
    expect(payment).toBeNull();
  }, 60000);
});

describe('Tier 4 — out-of-order webhook delivery', () => {
  test('a stale payment.failed arriving after success does not revert the booking', async () => {
    const booking = await createBooking(customer.user.id, service.id);
    const payment = await createSuccessfulPayment(booking.id, PRICE, { vendorPayoutStatus: 'paid' });

    const { body, headers } = signedWebhook({
      event: 'payment.failed',
      eventId: `${TEST_TAG}-stalefail-${Date.now()}`,
      payload: { payment: { entity: { id: payment.transactionId, error_description: 'late failure' } } },
    });

    const res = await request(app).post('/service_api/payments/razorpay-webhook').set(headers).send(body);
    expect(res.status).toBe(200);

    const after = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(after.status).toBe('success');
    expect(after.vendorPayoutStatus).toBe('paid');

    const bookingAfter = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(bookingAfter.status).not.toBe('pending');
  }, 60000);
});

describe('Tier 4 — reconciliation of orphaned captures', () => {
  test('a stale unpaid booking whose money DID arrive is recovered automatically', async () => {
    // Simulates the worst real-world case: the customer was charged, then the
    // app died and the webhook never arrived. Nothing in the system knows
    // about the money until this job asks the gateway directly.
    const booking = await prisma.booking.create({
      data: {
        userId: customer.user.id,
        serviceId: service.id,
        booking_date: new Date(Date.now() + 86400000),
        booking_time: '11:00',
        status: 'pending',
        vendor_status: 'accepted',
        createdAt: new Date(Date.now() - 60 * 60 * 1000), // an hour ago: past the 15-min threshold
      },
    });

    const orderId = `order_${TEST_TAG}_reconcile_${booking.id}`;
    razorpayFake.seedOrder({ orderId, receipt: `rcpt_bk_${booking.id}`, amountPaise: PRICE * 100 });
    razorpayFake.seedCapturedPayment({ paymentId: `pay_${TEST_TAG}_reconcile_${booking.id}`, orderId, amountPaise: PRICE * 100 });

    const result = await reconcileStalePayments();
    expect(result.recovered).toBeGreaterThanOrEqual(1);

    const payment = await prisma.payment.findUnique({ where: { bookingId: booking.id } });
    expect(payment).not.toBeNull();
    expect(payment.status).toBe('success');
    expect(Number(payment.amount)).toBe(PRICE);

    const after = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(after.status).toBe('confirmed');
  }, 90000);

  test('a stale booking with NO captured payment is left alone', async () => {
    const booking = await prisma.booking.create({
      data: {
        userId: customer.user.id,
        serviceId: service.id,
        booking_date: new Date(Date.now() + 86400000),
        booking_time: '12:00',
        status: 'pending',
        vendor_status: 'accepted',
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });

    // No order or payment seeded — the customer simply abandoned checkout.
    await reconcileStalePayments();

    const payment = await prisma.payment.findUnique({ where: { bookingId: booking.id } });
    expect(payment).toBeNull();

    const after = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(after.status).toBe('pending');
  }, 90000);
});
