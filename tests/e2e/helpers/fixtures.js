import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import prisma from '../../../util/prisma.js';

/**
 * Fixture builders for the E2E payment suite.
 *
 * ## Why fixtures are created directly via Prisma rather than over HTTP
 *
 * Signing up through the API would mean going through `strictAuthLimiter`,
 * which is **3 requests per 2 hours per IP** (middleware/rateLimitMiddleware.js),
 * plus an email OTP round-trip whose code is only echoed back in the response
 * when Resend *fails*. Neither is workable for a suite that needs fresh actors
 * per test, and neither is what's under test here — the subject is the payment
 * lifecycle, not registration. The manual runbook exercises real signup.
 *
 * Tokens are minted with the same payload shape the real code issues:
 *   - user/vendor: { id, type: 'access' }  (controllers/authController.js:44)
 *   - admin:       { id, role }            (controllers/Admin/authController.js:16)
 * so `protect` and `authAdmin` treat them exactly like production tokens.
 *
 * ## Live-database safety
 *
 * These tests run against the live Supabase database by explicit decision.
 * Every row created here is tagged with TEST_TAG so `cleanupTestData()` can
 * find and remove it precisely, without touching real data. Nothing here ever
 * truncates or mass-deletes — note that prisma/seed.js DOES truncate every
 * table and must never be run against this database.
 */

export const TEST_TAG = 'e2epay';

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Per-suite scope.
 *
 * Jest runs test files in parallel workers, and these suites all share one
 * live database. With a single global tag, one suite's cleanup deleted another
 * suite's fixtures while it was still using them — producing failures that
 * looked like real payment bugs but were just cross-suite interference. Each
 * suite therefore claims its own tag, and cleanup is scoped to it.
 *
 * TEST_TAG remains the common prefix so every row this harness has ever
 * created is still findable with a single LIKE '%e2epay%' query.
 */
let suiteTag = TEST_TAG;

export const setSuiteTag = (name) => {
  suiteTag = `${TEST_TAG}-${name}`;
  return suiteTag;
};

export const getSuiteTag = () => suiteTag;

/** Unique, greppable identifier so parallel or failed runs don't collide. */
export const runId = () => `${suiteTag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const testEmail = (role, id) => `${suiteTag}+${role}-${id}@keplix-e2e.invalid`;

export const userToken = (id) => jwt.sign({ id, type: 'access' }, JWT_SECRET, { expiresIn: '1d' });
export const adminToken = (id, role = 'admin') => jwt.sign({ id, role }, JWT_SECRET, { expiresIn: '15m' });

/**
 * Creates a verified customer. `is_verified` is set true and a profile row is
 * created because `protect` 403s ("Account not verified") on any user that has
 * neither.
 */
export const createCustomer = async (id = runId()) => {
  const user = await prisma.user.create({
    data: {
      email: testEmail('cust', id),
      password: await bcrypt.hash('e2e-password', 4),
      role: 'user',
      is_verified: true,
      userProfile: { create: { name: `E2E Customer ${id}` } },
    },
  });
  return { user, token: userToken(user.id) };
};

export const createVendor = async (id = runId()) => {
  const user = await prisma.user.create({
    data: {
      email: testEmail('vend', id),
      password: await bcrypt.hash('e2e-password', 4),
      role: 'vendor',
      is_verified: true,
      vendorProfile: { create: { business_name: `E2E Garage ${id}`, phone: '9000000000' } },
    },
  });
  return { user, token: userToken(user.id) };
};

/**
 * Marks a vendor payout-eligible. Written directly rather than going through
 * PUT /accounts/vendor, because that path calls the live RazorpayX contacts
 * and fund_accounts APIs — and, notably, *swallows* any failure
 * (controllers/vendor/profileController.js), so a vendor can complete
 * onboarding with no payout account and no error. The lifecycle test asserts
 * that real path separately; here we just need a payable vendor.
 */
export const givePayoutAccount = async (vendorId) => prisma.vendorPayoutAccount.create({
  data: {
    vendorId,
    contactId: `cont_${suiteTag}_${vendorId}`,
    fundAccountId: `fa_${suiteTag}_${vendorId}`,
    isActive: true,
  },
});

export const createAdmin = async (id = runId()) => {
  const admin = await prisma.admin.create({
    data: {
      email: testEmail('admin', id),
      password: await bcrypt.hash('e2e-password', 4),
      name: `E2E Admin ${id}`,
      role: 'admin',
      status: 'ACTIVE',
      phone: '0000000000',
    },
  });
  return { admin, token: adminToken(admin.id) };
};

export const createService = async (vendorId, price = 5000, id = runId()) => prisma.service.create({
  data: {
    vendorId,
    name: `E2E Service ${id}`,
    description: `${TEST_TAG} fixture`,
    price,
    duration: 60,
    category: 'general',
  },
});

/**
 * A booking in the state the payment endpoints expect. Defaults to
 * vendor-accepted/confirmed, which is what `/can-pay` requires before an
 * order can be created.
 */
export const createBooking = async (userId, serviceId, overrides = {}) => prisma.booking.create({
  data: {
    userId,
    serviceId,
    booking_date: new Date(Date.now() + 86400000),
    booking_time: '10:00',
    status: 'confirmed',
    vendor_status: 'accepted',
    ...overrides,
  },
});

/** A successful payment, for tests that start after the money has arrived. */
export const createSuccessfulPayment = async (bookingId, amount = 5000, overrides = {}) => {
  const platformFee = amount * 0.1;
  return prisma.payment.create({
    data: {
      bookingId,
      amount,
      currency: 'INR',
      status: 'success',
      method: 'razorpay',
      transactionId: `pay_${suiteTag}_${bookingId}_${Date.now()}`,
      platformFee,
      vendorAmount: amount - platformFee,
      vendorPayoutStatus: 'pending',
      ...overrides,
    },
  });
};

/**
 * Removes every row this suite created, in foreign-key-safe order.
 *
 * Payment→Booking, PayoutSettlement→Payment and Refund→Payment are all
 * onDelete: Restrict, so children must go first or the delete throws. Scoped
 * strictly to TEST_TAG-marked records — this must never become a broad delete,
 * because it runs against production data.
 */
export const cleanupTestData = async () => {
  const users = await prisma.user.findMany({
    where: { email: { contains: suiteTag } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);
  if (userIds.length === 0) {
    await prisma.admin.deleteMany({ where: { email: { contains: suiteTag } } });
    return { users: 0 };
  }

  const services = await prisma.service.findMany({ where: { vendorId: { in: userIds } }, select: { id: true } });
  const serviceIds = services.map((s) => s.id);

  const bookings = await prisma.booking.findMany({
    where: { OR: [{ userId: { in: userIds } }, { serviceId: { in: serviceIds } }] },
    select: { id: true },
  });
  const bookingIds = bookings.map((b) => b.id);

  const payments = await prisma.payment.findMany({
    where: { bookingId: { in: bookingIds } },
    select: { id: true },
  });
  const paymentIds = payments.map((p) => p.id);

  await prisma.refund.deleteMany({ where: { paymentId: { in: paymentIds } } });
  await prisma.payoutSettlement.deleteMany({ where: { paymentId: { in: paymentIds } } });
  await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } });
  await prisma.review.deleteMany({ where: { bookingId: { in: bookingIds } } });
  await prisma.conversation.deleteMany({ where: { bookingId: { in: bookingIds } } }).catch(() => {});
  await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
  await prisma.service.deleteMany({ where: { id: { in: serviceIds } } });
  await prisma.vendorPayoutAccount.deleteMany({ where: { vendorId: { in: userIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.userProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.vendorProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.admin.deleteMany({ where: { email: { contains: suiteTag } } });

  return { users: userIds.length, bookings: bookingIds.length, payments: paymentIds.length };
};

/** Also clears WebhookEvent rows created by the suite (they're keyed by our own event ids). */
/**
 * Clears WebhookEvent rows created by the harness.
 *
 * Filters on the broad TEST_TAG rather than the per-suite tag: test event ids
 * are built from TEST_TAG, so a suite-scoped filter silently matched nothing
 * and left rows behind. No genuine Razorpay event id can contain "e2epay", so
 * this stays precisely scoped to test data.
 */
export const cleanupWebhookEvents = async () => prisma.webhookEvent.deleteMany({
  where: { eventId: { contains: TEST_TAG } },
});
