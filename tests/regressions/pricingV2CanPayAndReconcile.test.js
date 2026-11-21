/**
 * Pricing v2, the remaining payment surfaces (docs/PRICING_V2_API.md section 6):
 * - can-pay: false with reason BILL_NOT_READY until a bill is issued; reason
 *   stays null for legacy bookings (older apps ignore the field).
 * - reconciliation cron: a recovered v2 capture is checked against the bill
 *   total, settles the bill, and never moves the booking back to confirmed.
 */
import { jest } from '@jest/globals';

const mockOrdersAll = jest.fn();
const mockFetchPayments = jest.fn();
jest.unstable_mockModule('razorpay', () => ({
  default: jest.fn().mockImplementation(() => ({ orders: { all: mockOrdersAll, fetchPayments: mockFetchPayments } })),
}));

const tx = {
  payment: { upsert: jest.fn(), update: jest.fn() },
  booking: { updateMany: jest.fn() },
  finalBill: { updateMany: jest.fn(), findUnique: jest.fn() },
  bookingEvent: { create: jest.fn() },
};
jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    booking: { findMany: jest.fn(), findUnique: jest.fn() },
    $transaction: jest.fn((cb) => cb(tx)),
  },
}));
jest.unstable_mockModule('../../util/platformSettings.js', () => ({
  resolvePlatformFeeRate: jest.fn().mockResolvedValue(0.1),
  computeSplit: (amount, rate) => {
    const paise = Math.round(Number(amount) * 100);
    const fee = Math.round(paise * rate);
    return { platformFee: fee / 100, vendorAmount: (paise - fee) / 100 };
  },
  isPricingV2ActiveFor: jest.fn().mockResolvedValue(false),
  getPlatformSettings: jest.fn().mockResolvedValue({}),
  resolvePayoutHoldUntil: jest.fn(),
}));
jest.unstable_mockModule('../../util/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn() },
}));
jest.unstable_mockModule('../../queues/notificationQueue.js', () => ({ addNotificationJob: jest.fn(), default: jest.fn() }));

const prisma = (await import('../../util/prisma.js')).default;
const platformSettings = await import('../../util/platformSettings.js');
const logger = (await import('../../util/logger.js')).default;
const { reconcileStalePayments } = await import('../../util/paymentReconciliation.js');
const { canProceedToPayment } = await import('../../controllers/user/bookingController.js');

const dec = (n) => ({ toString: () => String(n) });
const v2Booking = (o = {}) => ({
  id: 501, userId: 7, status: 'service_completed', vendor_status: 'accepted', payment: null,
  service: { id: 1, price: dec(1000), vendorId: 42 },
  bookingVehicle: { price_snapshot: dec(1000) },
  bookingQuote: { id: 9 },
  finalBills: [{ id: 3, status: 'issued', total: dec('7800.00') }],
  ...o,
});
const HOLD_UNTIL = new Date('2026-11-22T10:00:00Z');
const res = () => { const r = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r; };

beforeEach(() => {
  jest.clearAllMocks();
  tx.finalBill.updateMany.mockResolvedValue({ count: 1 });
  tx.finalBill.findUnique.mockResolvedValue({ status: 'paid' });
  tx.payment.upsert.mockImplementation(async ({ create }) => ({ id: 77, ...create }));
  tx.booking.updateMany.mockResolvedValue({ count: 1 });
  platformSettings.resolvePayoutHoldUntil.mockResolvedValue(HOLD_UNTIL);
});

describe('can-pay reason', () => {
  const ask = async () => {
    const r = res();
    await canProceedToPayment({ params: { id: '501' }, user: { id: 7 } }, r);
    return r.json.mock.calls[0][0];
  };

  test('v2 with no bill -> canPay false, reason BILL_NOT_READY', async () => {
    prisma.booking.findUnique.mockResolvedValue(v2Booking({ status: 'in_progress', finalBills: [] }));
    expect(await ask()).toMatchObject({ canPay: false, reason: 'BILL_NOT_READY' });
  });

  test('v2 with an issued bill -> canPay true, reason null', async () => {
    prisma.booking.findUnique.mockResolvedValue(v2Booking({ status: 'in_progress' }));
    expect(await ask()).toMatchObject({ canPay: true, reason: null });
  });

  test('legacy -> unchanged rule, reason null', async () => {
    prisma.booking.findUnique.mockResolvedValue(v2Booking({ status: 'confirmed', bookingQuote: null, finalBills: [] }));
    expect(await ask()).toMatchObject({ canPay: true, reason: null });
  });
});

describe('reconciliation v2 branch', () => {
  const onTopV2Notes = { bookingId: '501', servicePrice: '7800.00', platformFee: '780.00', feeModel: 'on_top', finalBillId: '3' };

  test('the sweep also looks at billed, unpaid v2 bookings', async () => {
    prisma.booking.findMany.mockResolvedValue([]);
    await reconcileStalePayments();
    const { where, include } = prisma.booking.findMany.mock.calls[0][0];
    expect(where.OR).toContainEqual(expect.objectContaining({ bookingQuote: { isNot: null }, status: { in: ['in_progress', 'service_completed'] } }));
    expect(include).toMatchObject({ bookingQuote: expect.anything(), finalBills: expect.anything() });
  });

  test('recovered v2 capture: bill total recorded, bill paid, booking status untouched', async () => {
    prisma.booking.findMany.mockResolvedValue([v2Booking()]);
    mockOrdersAll.mockResolvedValue({ items: [{ id: 'order_1', notes: onTopV2Notes }] });
    mockFetchPayments.mockResolvedValue({ items: [{ id: 'pay_1', status: 'captured', amount: 858000 }] });

    const out = await reconcileStalePayments();

    expect(out.recovered).toBe(1);
    expect(tx.payment.upsert.mock.calls[0][0].create).toMatchObject({ amount: 8580, vendorAmount: 7800, feeModel: 'on_top' });
    expect(tx.finalBill.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 3, bookingId: 501, status: 'issued' } }));
    expect(tx.bookingEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'final_bill_paid' }) });
    // Never moved back to confirmed. The only booking write is the review-fix
    // confirm-window restart, guarded on service_completed.
    for (const [arg] of tx.booking.updateMany.mock.calls) {
      expect(arg.data).not.toHaveProperty('status');
      expect(arg.where.status).toBe('service_completed');
    }
  });

  // Review fix 2026-11-21: reconciliation is the third success path and must
  // apply the same escrow + void-race handling as verify/webhook.
  test('recovered v2 capture gets the payout hold and a restarted confirm window', async () => {
    prisma.booking.findMany.mockResolvedValue([v2Booking()]);
    mockOrdersAll.mockResolvedValue({ items: [{ id: 'order_1', notes: onTopV2Notes }] });
    mockFetchPayments.mockResolvedValue({ items: [{ id: 'pay_1', status: 'captured', amount: 858000 }] });
    await reconcileStalePayments();
    expect(platformSettings.resolvePayoutHoldUntil).toHaveBeenCalledTimes(1);
    expect(tx.payment.update).toHaveBeenCalledWith({ where: { id: 77 }, data: { payoutHoldUntil: HOLD_UNTIL } });
    expect(tx.booking.updateMany).toHaveBeenCalledWith({ where: { id: 501, status: 'service_completed' }, data: { service_completed_at: expect.any(Date) } });
  });

  test('hold lookup failure: payment still recovered, no hold written', async () => {
    platformSettings.resolvePayoutHoldUntil.mockRejectedValue(new Error('db blip'));
    prisma.booking.findMany.mockResolvedValue([v2Booking()]);
    mockOrdersAll.mockResolvedValue({ items: [{ id: 'order_1', notes: onTopV2Notes }] });
    mockFetchPayments.mockResolvedValue({ items: [{ id: 'pay_1', status: 'captured', amount: 858000 }] });
    expect((await reconcileStalePayments()).recovered).toBe(1);
    expect(tx.payment.update).not.toHaveBeenCalled();
  });

  test('bill voided before the recovered capture is recorded: kept, flagged with event + [MANUAL ACTION]', async () => {
    tx.finalBill.updateMany.mockResolvedValue({ count: 0 });
    tx.finalBill.findUnique.mockResolvedValue({ status: 'void' });
    prisma.booking.findMany.mockResolvedValue([v2Booking()]);
    mockOrdersAll.mockResolvedValue({ items: [{ id: 'order_1', notes: onTopV2Notes }] });
    mockFetchPayments.mockResolvedValue({ items: [{ id: 'pay_1', status: 'captured', amount: 858000 }] });
    expect((await reconcileStalePayments()).recovered).toBe(1);
    expect(tx.bookingEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'payment_bill_mismatch', payload: expect.objectContaining({ via: 'reconciliation', razorpayPaymentId: 'pay_1' }) }),
    });
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/^\[MANUAL ACTION\] \[Reconciliation\]/));
  });

  test('legacy recovery: no hold lookup, no window restart', async () => {
    prisma.booking.findMany.mockResolvedValue([v2Booking({ status: 'confirmed', bookingQuote: null, finalBills: [] })]);
    mockOrdersAll.mockResolvedValue({ items: [{ id: 'order_1', notes: { bookingId: '501' } }] });
    mockFetchPayments.mockResolvedValue({ items: [{ id: 'pay_1', status: 'captured', amount: 100000 }] });
    expect((await reconcileStalePayments()).recovered).toBe(1);
    expect(platformSettings.resolvePayoutHoldUntil).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.booking.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.booking.updateMany.mock.calls[0][0].data).toEqual({ status: 'confirmed' });
  });

  test('capture that does not match the bill is left for manual review', async () => {
    prisma.booking.findMany.mockResolvedValue([v2Booking()]);
    mockOrdersAll.mockResolvedValue({ items: [{ id: 'order_1', notes: onTopV2Notes }] });
    mockFetchPayments.mockResolvedValue({ items: [{ id: 'pay_1', status: 'captured', amount: 110000 }] });
    expect((await reconcileStalePayments()).recovered).toBe(0);
    expect(tx.payment.upsert).not.toHaveBeenCalled();
  });
});
