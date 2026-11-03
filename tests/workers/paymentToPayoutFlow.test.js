import { jest } from '@jest/globals';

/**
 * Full payout flow (2026-11-03, owner asked "does the vendor really get the
 * money?"). Runs the REAL code in order -- claimAndQueuePayout (admin "Pay"),
 * then processPayoutJob (the worker), then payoutHelper -- against an
 * in-memory database and a fake RazorpayX. Only the edges are faked: the
 * database, the queue, the RazorpayX HTTP client and notifications. No real
 * money moves.
 *
 * Checks the exact paise sent, the vendor account, the idempotency key, the
 * final status and the vendor's "payout sent" notice, plus the cases that
 * must NOT pay: a refund racing the queued job, and a refused payout.
 */

const mockNotify = jest.fn().mockResolvedValue({});
const mockAddPayoutJob = jest.fn();

// ---- in-memory database ----------------------------------------------------
let db;
const decimal = (n) => (n == null ? n : { toString: () => String(n), valueOf: () => Number(n) });
const applyData = (row, data) => {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in v) row[k] = (row[k] || 0) + v.increment;
    else row[k] = v;
  }
  return row;
};
const statusIn = (where, row) => !where?.status?.in || where.status.in.includes(row.status);
const paymentView = (p) => ({
  ...p,
  amount: decimal(p.amount),
  platformFee: decimal(p.platformFee),
  vendorAmount: decimal(p.vendorAmount),
  booking: db.booking,
});

const mockPrisma = {
  $transaction: (cb) => cb(mockPrisma),
  $queryRaw: async () => [],
  payment: {
    findUnique: async ({ where }) => (db.payment && db.payment.id === where.id ? paymentView(db.payment) : null),
    update: async ({ data }) => paymentView(applyData(db.payment, data)),
  },
  refund: {
    findFirst: async ({ where }) => db.refunds.find((r) => statusIn(where, r)) || null,
    findMany: async ({ where }) => db.refunds.filter((r) => statusIn(where, r)).map((r) => ({ ...r, amount: decimal(r.amount) })),
  },
  payoutSettlement: {
    upsert: async ({ create }) => {
      if (!db.settlement) db.settlement = { attempts: 0, gatewayResponse: null, gatewayPayoutId: null, ...create };
      return { ...db.settlement };
    },
    update: async ({ data }) => ({ ...applyData(db.settlement, data) }),
    updateMany: async ({ where, data }) => {
      if (!db.settlement || !statusIn(where, db.settlement)) return { count: 0 };
      applyData(db.settlement, data);
      return { count: 1 };
    },
  },
  vendorPayoutAccount: {
    findUnique: async () => ({ vendorId: 9, isActive: true, fundAccountId: 'fa_1' }),
  },
  platformSettings: { findFirst: async () => db.platformSettings },
};

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../queues/payoutQueue.js', () => ({ addPayoutJob: mockAddPayoutJob }));
jest.unstable_mockModule('../../util/notificationHelper.js', () => ({ createNotification: mockNotify }));
// refundService builds a Razorpay client when imported.
jest.unstable_mockModule('razorpay', () => ({
  default: jest.fn().mockImplementation(() => ({ payments: { refund: jest.fn() }, refunds: { fetch: jest.fn() } })),
}));

const { claimAndQueuePayout } = await import('../../services/payoutService.js');
const { processPayoutJob } = await import('../../workers/payoutProcessor.js');
const { __setRazorpayXClientForTests } = await import('../../util/payoutHelper.js');
const { recomputeSplitAfterRefunds } = await import('../../services/refundService.js');
const { computeSplit, resolvePlatformFeeRate } = await import('../../util/platformSettings.js');

// ---- fake RazorpayX --------------------------------------------------------
let payoutReplies;
const razorpayX = {
  fetchFundAccount: jest.fn(async (id) => ({ id, account_type: 'bank_account' })),
  createPayout: jest.fn(async (body) => ({ id: `pout_${razorpayX.createPayout.mock.calls.length}`, ...body, ...payoutReplies.shift() })),
  fetchPayout: jest.fn(),
};

/** What verify writes: the split of what the customer paid. */
const seedPaidBooking = async (amount) => {
  const rate = await resolvePlatformFeeRate();
  const { platformFee, vendorAmount } = computeSplit(amount, rate);
  db.booking = { id: 1760, status: 'service_completed', service: { vendorId: 9, name: 'Car wash' } };
  db.payment = {
    id: 5, bookingId: 1760, method: 'razorpay', status: 'success', amount,
    platformFee, vendorAmount, vendorPayoutStatus: 'pending', payoutHoldUntil: null,
  };
};

/** Admin presses Pay, then the worker runs the job that was queued. */
const payVendor = async () => {
  await claimAndQueuePayout(5);
  const [jobData] = mockAddPayoutJob.mock.calls.at(-1);
  await processPayoutJob({ data: jobData });
};

const ORIGINAL_ACCOUNT = process.env.RAZORPAYX_ACCOUNT_NUMBER;
beforeAll(() => {
  process.env.RAZORPAYX_ACCOUNT_NUMBER = 'test_account_0000';
  __setRazorpayXClientForTests(razorpayX);
});
afterAll(() => {
  process.env.RAZORPAYX_ACCOUNT_NUMBER = ORIGINAL_ACCOUNT;
  __setRazorpayXClientForTests(null);
});
beforeEach(() => {
  jest.clearAllMocks();
  db = { payment: null, booking: null, refunds: [], settlement: null, platformSettings: null };
  payoutReplies = [{ status: 'processed' }];
});

test('₹1000 paid: vendor is sent exactly ₹900, Keplix keeps ₹100', async () => {
  await seedPaidBooking(1000);
  expect(db.payment.platformFee).toBe(100);

  await payVendor();

  expect(razorpayX.createPayout).toHaveBeenCalledTimes(1);
  const [body, key] = razorpayX.createPayout.mock.calls[0];
  expect(body).toMatchObject({ amount: 90000, currency: 'INR', fund_account_id: 'fa_1', account_number: 'test_account_0000', mode: 'IMPS' });
  expect(key).toBe('payout_payment_5');
  expect(db.payment.vendorPayoutStatus).toBe('paid');
  expect(db.settlement.status).toBe('settled');
  expect(mockNotify).toHaveBeenCalledTimes(1);
  expect(mockNotify.mock.calls[0][0]).toBe(9);
});

test('₹999.99: the split adds up to the paisa', async () => {
  await seedPaidBooking(999.99);
  expect(db.payment.platformFee + db.payment.vendorAmount).toBeCloseTo(999.99, 10);

  await payVendor();

  expect(razorpayX.createPayout.mock.calls[0][0].amount).toBe(89999); // 99999 - 10000
});

test('fee turned off: vendor gets the whole amount', async () => {
  db.platformSettings = { isPlatformFeeEnabled: false, platformFeePercentage: 0.1 };
  await seedPaidBooking(1000);

  await payVendor();

  expect(razorpayX.createPayout.mock.calls[0][0].amount).toBe(100000);
});

test('₹200 partial refund: vendor gets 90% of the ₹800 left = ₹720', async () => {
  await seedPaidBooking(1000);
  db.refunds.push({ id: 1, paymentId: 5, amount: 200, status: 'processed' });
  await recomputeSplitAfterRefunds(5);
  expect(db.payment).toMatchObject({ platformFee: 80, vendorAmount: 720 });

  await payVendor();

  expect(razorpayX.createPayout.mock.calls[0][0].amount).toBe(72000);
  expect(db.payment.vendorPayoutStatus).toBe('paid');
});

test('a refund that starts after the job is queued stops the payout', async () => {
  await seedPaidBooking(1000);
  await claimAndQueuePayout(5);
  // The customer's refund begins while the job waits in the queue.
  db.refunds.push({ id: 2, paymentId: 5, amount: 1000, status: 'initiated' });

  await processPayoutJob({ data: mockAddPayoutJob.mock.calls[0][0] });

  expect(razorpayX.createPayout).not.toHaveBeenCalled();
  expect(db.payment.vendorPayoutStatus).toBe('pending');
  expect(db.settlement.status).toBe('gateway_failed');
  expect(mockNotify).not.toHaveBeenCalled();
});

test('a booking cancelled after queueing is not paid', async () => {
  await seedPaidBooking(1000);
  await claimAndQueuePayout(5);
  db.booking.status = 'cancelled';

  await processPayoutJob({ data: mockAddPayoutJob.mock.calls[0][0] });

  expect(razorpayX.createPayout).not.toHaveBeenCalled();
});

test('RazorpayX refuses: marked failed, and a retry uses a new key and pays once', async () => {
  payoutReplies = [{ status: 'rejected', status_details: { description: 'compliance' } }, { status: 'processed' }];
  await seedPaidBooking(1000);

  await payVendor();
  expect(db.payment.vendorPayoutStatus).toBe('failed');
  expect(mockNotify).not.toHaveBeenCalled();

  await payVendor(); // admin presses Retry
  const keys = razorpayX.createPayout.mock.calls.map(([, k]) => k);
  expect(keys).toEqual(['payout_payment_5', 'payout_payment_5_r1']);
  expect(db.payment.vendorPayoutStatus).toBe('paid');
  expect(mockNotify).toHaveBeenCalledTimes(1);
});

test('accepted but not yet processed: not marked paid, and no second transfer later', async () => {
  payoutReplies = [{ status: 'queued' }];
  await seedPaidBooking(1000);

  await payVendor();
  expect(db.payment.vendorPayoutStatus).toBe('processing');
  expect(db.settlement.status).toBe('gateway_confirmed');
  expect(mockNotify).not.toHaveBeenCalled();

  // The 5-minute check re-runs the job; RazorpayX now says processed.
  razorpayX.fetchPayout.mockResolvedValue({ id: 'pout_1', status: 'processed' });
  await processPayoutJob({ data: { paymentId: 5, vendorId: 9, bookingId: 1760 } });

  expect(razorpayX.createPayout).toHaveBeenCalledTimes(1);
  expect(db.payment.vendorPayoutStatus).toBe('paid');
  expect(mockNotify).toHaveBeenCalledTimes(1);
});

test('admin cannot pay twice', async () => {
  await seedPaidBooking(1000);
  await payVendor();
  await expect(claimAndQueuePayout(5)).rejects.toThrow(/Already settled/);
  expect(razorpayX.createPayout).toHaveBeenCalledTimes(1);
});
