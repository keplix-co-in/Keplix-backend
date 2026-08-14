import { jest } from '@jest/globals';

/**
 * TIER 1 — FULL LIFECYCLE
 *
 * The complete money path, driven over real HTTP in the real order, with the
 * database asserted at every hop:
 *
 *   customer books → vendor accepts → customer pays → webhook confirms
 *   → vendor completes → customer confirms → payout enqueued → worker
 *   transfers → vendor is paid → admin refunds
 *
 * This is the automated mirror of docs/PAYMENT-TEST-RUNBOOK.md. The runbook
 * covers what a human must see (app screens, the admin panel); this covers the
 * state transitions underneath them.
 *
 * The tests run in sequence and share state deliberately — a lifecycle is a
 * sequence, and testing each hop in isolation would not prove the hops connect.
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

// The queue is stubbed so the test drives the worker explicitly rather than
// waiting on Redis — the payout still runs, just deterministically.
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
  createCustomer, createVendor, createAdmin, createService,
  givePayoutAccount, setSuiteTag, cleanupTestData, cleanupWebhookEvents, TEST_TAG,
} = await import('./helpers/fixtures.js');

setSuiteTag('life');

const { paymentSignature, capturedPaymentWebhook } = await import('./helpers/razorpay.js');

const PRICE = 4000;
const EXPECTED_FEE = PRICE * 0.1;
const EXPECTED_VENDOR_SHARE = PRICE - EXPECTED_FEE;

let customer, vendor, admin, service;
// Carried across the sequence.
const state = {};

beforeAll(async () => {
  customer = await createCustomer();
  vendor = await createVendor();
  admin = await createAdmin();
  service = await createService(vendor.user.id, PRICE);
}, 60000);

afterAll(async () => {
  await cleanupWebhookEvents();
  await cleanupTestData();
  await prisma.$disconnect();
}, 60000);

describe('Lifecycle 1 — customer books', () => {
  test('the vendor becomes payout-eligible only once a payout account exists', async () => {
    // Onboarding SWALLOWS RazorpayX failures (profileController.js), so a
    // vendor can finish onboarding with no payout account and no error shown
    // anywhere — the first symptom is a failed settle days later. Assert the
    // precondition explicitly rather than assuming onboarding produced it.
    const before = await prisma.vendorPayoutAccount.findUnique({ where: { vendorId: vendor.user.id } });
    expect(before).toBeNull();

    await givePayoutAccount(vendor.user.id);

    const after = await prisma.vendorPayoutAccount.findUnique({ where: { vendorId: vendor.user.id } });
    expect(after.isActive).toBe(true);
    expect(after.fundAccountId).toBeTruthy();
  }, 60000);

  test('the admin payout queue flags vendors who cannot be paid, before anyone clicks settle', async () => {
    // A payout for a vendor with no payout account is a guaranteed failure.
    // It used to be discovered only after settling; the queue now reports it
    // up front so the admin can chase the vendor instead.
    const brokenVendor = await createVendor();
    const brokenService = await createService(brokenVendor.user.id, 1000);
    const brokenBooking = await prisma.booking.create({
      data: {
        userId: customer.user.id,
        serviceId: brokenService.id,
        booking_date: new Date(Date.now() + 86400000),
        booking_time: '09:00',
        status: 'confirmed',
        vendor_status: 'accepted',
      },
    });
    const brokenPayment = await prisma.payment.create({
      data: {
        bookingId: brokenBooking.id,
        amount: 1000, currency: 'INR', status: 'success', method: 'razorpay',
        transactionId: `pay_${TEST_TAG}_noacct_${Date.now()}`,
        platformFee: 100, vendorAmount: 900, vendorPayoutStatus: 'pending',
      },
    });

    const res = await request(app)
      .get('/admin/finance/payouts')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);

    const blocked = res.body.find((p) => p.id === brokenPayment.id);
    expect(blocked.payoutReady).toBe(false);
    expect(blocked.payoutBlockedReason).toMatch(/no payout account/i);

    // And our properly-configured vendor is reported as ready.
    const okVendorRow = res.body.find(
      (p) => p.booking?.service?.vendor?.VendorPayoutAccount?.isActive === true,
    );
    if (okVendorRow) expect(okVendorRow.payoutReady).toBe(true);
  }, 60000);

  test('the customer creates a booking, which starts unaccepted and unpayable', async () => {
    const res = await request(app)
      .post(`/service_api/user/${customer.user.id}/bookings/create`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({
        serviceId: service.id,
        booking_date: new Date(Date.now() + 86400000).toISOString(),
        booking_time: '10:00',
      });

    expect(res.status).toBe(201);
    state.bookingId = res.body?.booking?.id ?? res.body?.id ?? res.body?.data?.id;
    expect(state.bookingId).toBeTruthy();

    const booking = await prisma.booking.findUnique({ where: { id: state.bookingId } });
    expect(booking.status).toBe('pending');
    expect(booking.vendor_status).toBe('pending');

    const canPay = await request(app)
      .get(`/service_api/user/${customer.user.id}/bookings/${state.bookingId}/can-pay`)
      .set('Authorization', `Bearer ${customer.token}`);
    expect(canPay.body.canPay).toBe(false);
  }, 60000);
});

describe('Lifecycle 2 — vendor accepts', () => {
  test('acceptance makes the booking payable', async () => {
    const res = await request(app)
      .patch(`/service_api/vendor/${vendor.user.id}/bookings/${state.bookingId}/respond`)
      .set('Authorization', `Bearer ${vendor.token}`)
      .send({ vendor_status: 'accepted' });

    expect(res.status).toBe(200);

    const booking = await prisma.booking.findUnique({ where: { id: state.bookingId } });
    expect(booking.vendor_status).toBe('accepted');

    const canPay = await request(app)
      .get(`/service_api/user/${customer.user.id}/bookings/${state.bookingId}/can-pay`)
      .set('Authorization', `Bearer ${customer.token}`);
    expect(canPay.body.canPay).toBe(true);
  }, 60000);
});

describe('Lifecycle 3 — customer pays', () => {
  test('the order is priced by the server from the service, not the client', async () => {
    const res = await request(app)
      .post('/service_api/payments/order/create')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ bookingId: state.bookingId, amount: 1 }); // client tries to underpay

    expect(res.status).toBe(200);
    state.orderId = res.body.orderId || res.body.id;

    const sentToGateway = razorpayFake.calls.ordersCreate.at(-1).params;
    expect(sentToGateway.amount).toBe(PRICE * 100);
    // The booking link the webhook fallback and reconciliation both rely on.
    expect(sentToGateway.receipt).toBe(`rcpt_bk_${state.bookingId}`);
    expect(sentToGateway.notes.bookingId).toBe(String(state.bookingId));
  }, 60000);

  test('verification records the payment with the correct commission split', async () => {
    state.paymentId = `pay_${TEST_TAG}_life_${Date.now()}`;
    razorpayFake.seedCapturedPayment({
      paymentId: state.paymentId, orderId: state.orderId, amountPaise: PRICE * 100,
    });

    const res = await request(app)
      .post('/service_api/payments/verify')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({
        bookingId: state.bookingId,
        orderId: state.orderId,
        paymentId: state.paymentId,
        signature: paymentSignature(state.orderId, state.paymentId),
        gateway: 'razorpay',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.platformFee).toBeCloseTo(EXPECTED_FEE, 2);
    expect(res.body.vendorAmount).toBeCloseTo(EXPECTED_VENDOR_SHARE, 2);

    const payment = await prisma.payment.findUnique({ where: { bookingId: state.bookingId } });
    state.paymentRowId = payment.id;
    expect(payment.status).toBe('success');
    expect(Number(payment.amount)).toBe(PRICE);
    expect(Number(payment.platformFee)).toBeCloseTo(EXPECTED_FEE, 2);
    expect(Number(payment.vendorAmount)).toBeCloseTo(EXPECTED_VENDOR_SHARE, 2);
    expect(payment.vendorPayoutStatus).toBe('pending');

    // Money is held by Keplix at this point — nothing owed out yet.
    const booking = await prisma.booking.findUnique({ where: { id: state.bookingId } });
    expect(booking.status).toBe('confirmed');
  }, 60000);

  test('the matching webhook arrives and changes nothing (it is a duplicate of the client callback)', async () => {
    const { body, headers } = capturedPaymentWebhook({
      paymentId: state.paymentId,
      orderId: state.orderId,
      amountPaise: PRICE * 100,
      bookingId: state.bookingId,
      eventId: `${TEST_TAG}-life-${Date.now()}`,
    });

    const res = await request(app).post('/service_api/payments/razorpay-webhook').set(headers).send(body);
    expect(res.status).toBe(200);

    const payments = await prisma.payment.findMany({ where: { bookingId: state.bookingId } });
    expect(payments).toHaveLength(1);
    expect(payments[0].vendorPayoutStatus).toBe('pending'); // not re-armed
  }, 60000);
});

describe('Lifecycle 4 — vendor performs the service', () => {
  test('the vendor moves the booking to in_progress then service_completed', async () => {
    const inProgress = await request(app)
      .patch(`/service_api/vendor/${vendor.user.id}/bookings/update/${state.bookingId}`)
      .set('Authorization', `Bearer ${vendor.token}`)
      .send({ status: 'in_progress' });
    expect([200, 201]).toContain(inProgress.status);

    const completed = await request(app)
      .patch(`/service_api/vendor/${vendor.user.id}/bookings/update/${state.bookingId}`)
      .set('Authorization', `Bearer ${vendor.token}`)
      .send({ status: 'service_completed' });
    expect([200, 201]).toContain(completed.status);

    const booking = await prisma.booking.findUnique({ where: { id: state.bookingId } });
    expect(booking.status).toBe('service_completed');

    // The vendor is owed money but has not been paid.
    const payment = await prisma.payment.findUnique({ where: { id: state.paymentRowId } });
    expect(payment.vendorPayoutStatus).toBe('pending');
  }, 60000);
});

describe('Lifecycle 5 — escrow release', () => {
  test('the admin sees the payout in the pending queue with the correct vendor share', async () => {
    const res = await request(app)
      .get('/admin/finance/payouts')
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.status).toBe(200);
    const ours = res.body.find((p) => p.id === state.paymentRowId);
    expect(ours).toBeTruthy();
    expect(Number(ours.vendorAmount)).toBeCloseTo(EXPECTED_VENDOR_SHARE, 2);
  }, 60000);

  test('the customer confirming the service claims the payout exactly once', async () => {
    const res = await request(app)
      .post(`/service_api/user/${customer.user.id}/bookings/${state.bookingId}/confirm`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ confirmed: true, rating: 5, comment: 'E2E lifecycle' });

    expect(res.status).toBe(200);
    expect(mockAddPayoutJob).toHaveBeenCalledTimes(1);

    const payment = await prisma.payment.findUnique({ where: { id: state.paymentRowId } });
    expect(payment.vendorPayoutStatus).toBe('processing');
  }, 60000);

  test('an admin settle on the same payment is refused — it is already claimed', async () => {
    const res = await request(app)
      .post(`/admin/finance/payouts/${state.paymentRowId}/settle`)
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.status).toBe(400);
    expect(mockAddPayoutJob).toHaveBeenCalledTimes(1); // still just the one
  }, 60000);
});

describe('Lifecycle 6 — the vendor gets paid', () => {
  test('the worker transfers the vendor share and records a settled ledger entry', async () => {
    const job = mockAddPayoutJob.mock.calls[0][0];
    expect(job.paymentId).toBe(state.paymentRowId);

    await processPayoutJob({ data: job });

    expect(razorpayFake.calls.payoutsCreate).toHaveLength(1);
    const transfer = razorpayFake.calls.payoutsCreate[0];
    expect(transfer.params.amount).toBe(Math.round(EXPECTED_VENDOR_SHARE * 100));
    // Idempotency header keyed on the payment: a retry cannot double-pay.
    expect(transfer.headers['X-Payout-Idempotency']).toBe(`payout_payment_${state.paymentRowId}`);

    const settlement = await prisma.payoutSettlement.findUnique({ where: { paymentId: state.paymentRowId } });
    expect(settlement.status).toBe('settled');

    const payment = await prisma.payment.findUnique({ where: { id: state.paymentRowId } });
    expect(payment.vendorPayoutStatus).toBe('paid');
    expect(payment.vendorPayoutId).toBeTruthy();
  }, 60000);

  test('the vendor is notified and their earnings reflect the payout', async () => {
    const notifications = await prisma.notification.findMany({ where: { userId: vendor.user.id } });
    expect(notifications.length).toBeGreaterThanOrEqual(1);

    const res = await request(app)
      .get(`/service_api/vendor/${vendor.user.id}/earning`)
      .set('Authorization', `Bearer ${vendor.token}`);

    expect(res.status).toBe(200);
    expect(res.body.total_earnings).toBeCloseTo(EXPECTED_VENDOR_SHARE, 2);
    expect(res.body.pending_earnings).toBeCloseTo(0, 2);
  }, 60000);

  test('re-running the payout job is a no-op — the money does not move twice', async () => {
    const job = mockAddPayoutJob.mock.calls[0][0];
    await processPayoutJob({ data: job });

    expect(razorpayFake.calls.payoutsCreate).toHaveLength(1);
  }, 60000);
});

describe('Lifecycle 7 — refund after settlement', () => {
  test('a partial refund succeeds and warns that the vendor was already paid', async () => {
    const res = await request(app)
      .post(`/admin/finance/payments/${state.paymentRowId}/refund`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ amount: 1000, reason: 'E2E partial', idempotencyKey: `${TEST_TAG}-life-refund-1` });

    expect(res.status).toBe(200);
    // Keplix is now out of pocket: the vendor's share left before the refund.
    expect(res.body.payoutAlreadySettled).toBe(true);
    expect(razorpayFake.calls.paymentsRefund).toHaveLength(1);

    const refunds = await prisma.refund.findMany({ where: { paymentId: state.paymentRowId } });
    expect(refunds).toHaveLength(1);
    expect(Number(refunds[0].amount)).toBe(1000);
  }, 60000);

  test('a second refund is capped at the remaining balance', async () => {
    const tooMuch = await request(app)
      .post(`/admin/finance/payments/${state.paymentRowId}/refund`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ amount: PRICE, idempotencyKey: `${TEST_TAG}-life-refund-toobig` });

    expect(tooMuch.status).toBe(400);

    const remainder = await request(app)
      .post(`/admin/finance/payments/${state.paymentRowId}/refund`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ idempotencyKey: `${TEST_TAG}-life-refund-2` }); // no amount = the rest

    expect(remainder.status).toBe(200);

    const refunds = await prisma.refund.findMany({
      where: { paymentId: state.paymentRowId, status: { not: 'gateway_failed' } },
    });
    const total = refunds.reduce((sum, r) => sum + Number(r.amount), 0);
    expect(total).toBeCloseTo(PRICE, 2);

    const payment = await prisma.payment.findUnique({ where: { id: state.paymentRowId } });
    expect(payment.status).toBe('refunded');
  }, 60000);

  test('nothing further can be refunded once the payment is fully refunded', async () => {
    const res = await request(app)
      .post(`/admin/finance/payments/${state.paymentRowId}/refund`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ amount: 1, idempotencyKey: `${TEST_TAG}-life-refund-3` });

    expect(res.status).toBe(400);
  }, 60000);
});
