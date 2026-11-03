import { jest } from '@jest/globals';

// Unit tests for the payout worker's state machine. The e2e tests cover it
// against a real database; these pin the 2026-11-03 rules without one:
//   - only RazorpayX status "processed" means paid (queued/processing don't)
//   - a payout already accepted is checked, never created again
//   - a refused payout is not retried, and a re-trigger uses a new key

const mockPrisma = {
  payment: { findUnique: jest.fn(), update: jest.fn() },
  payoutSettlement: { upsert: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findMany: jest.fn() },
  // The worker re-checks for an open refund just before sending money.
  refund: { findFirst: jest.fn() },
};
const mockInitiate = jest.fn();
const mockFetchPayout = jest.fn();
const mockNotify = jest.fn();

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../util/payoutHelper.js', () => ({
  initiateVendorPayout: mockInitiate,
  fetchVendorPayout: mockFetchPayout,
  describePayoutFailure: (p) => `RazorpayX payout ${p.id} ${p.status}: ${p.status_details?.description || p.status}`,
}));
jest.unstable_mockModule('../../util/notificationHelper.js', () => ({ createNotification: mockNotify }));
jest.unstable_mockModule('../../util/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { processPayoutJob, reconcileInFlightPayouts } = await import('../../workers/payoutProcessor.js');

const job = { data: { paymentId: 77, vendorId: 5, bookingId: 9 } };
const payment = { id: 77, status: 'success', vendorAmount: '450.00', vendorPayoutStatus: 'processing', bookingId: 9, booking: { id: 9, status: 'user_confirmed', service: { name: 'Oil change', vendorId: 5 } } };
const settlement = (over = {}) => ({ paymentId: 77, status: 'initiated', gatewayPayoutId: null, gatewayResponse: null, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.payment.findUnique.mockResolvedValue(payment);
  mockPrisma.payment.update.mockResolvedValue({});
  mockPrisma.payoutSettlement.update.mockResolvedValue({});
  mockPrisma.payoutSettlement.updateMany.mockResolvedValue({ count: 1 });
  mockNotify.mockResolvedValue({});
  mockPrisma.refund.findFirst.mockResolvedValue(null);
});

describe('new payout', () => {
  test('processed: settled, payment paid, vendor notified', async () => {
    mockPrisma.payoutSettlement.upsert.mockResolvedValue(settlement());
    mockInitiate.mockResolvedValue({ success: true, payoutId: 'pout_1', status: 'processed' });

    await processPayoutJob(job);

    expect(mockInitiate).toHaveBeenCalledWith(payment, 5, { idempotencyKey: 'payout_payment_77' });
    expect(mockPrisma.payoutSettlement.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'gateway_confirmed', gatewayPayoutId: 'pout_1' }),
    }));
    expect(mockPrisma.payment.update).toHaveBeenCalledWith({
      where: { id: 77 }, data: { vendorPayoutStatus: 'paid', vendorPayoutId: 'pout_1' },
    });
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  test('processing/queued: not paid yet, no notification, payout id kept', async () => {
    mockPrisma.payoutSettlement.upsert.mockResolvedValue(settlement());
    mockInitiate.mockResolvedValue({ success: true, payoutId: 'pout_1', status: 'queued' });

    await processPayoutJob(job);

    expect(mockPrisma.payoutSettlement.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.payment.update).toHaveBeenCalledWith({ where: { id: 77 }, data: { vendorPayoutId: 'pout_1' } });
    expect(mockPrisma.payment.update).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ vendorPayoutStatus: 'paid' }),
    }));
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('refused by RazorpayX: gateway_failed, refused id stored, not rethrown', async () => {
    mockPrisma.payoutSettlement.upsert.mockResolvedValue(settlement());
    mockInitiate.mockResolvedValue({ success: false, terminal: true, payoutId: 'pout_bad', status: 'rejected', error: 'rejected: compliance' });

    await expect(processPayoutJob(job)).resolves.toBeUndefined();

    expect(mockPrisma.payoutSettlement.update).toHaveBeenCalledWith({
      where: { paymentId: 77 },
      data: expect.objectContaining({
        status: 'gateway_failed',
        gatewayResponse: JSON.stringify({ refusedPayoutIds: ['pout_bad'] }),
        attempts: { increment: 1 },
      }),
    });
    expect(mockPrisma.payment.update).toHaveBeenCalledWith({ where: { id: 77 }, data: { vendorPayoutStatus: 'failed' } });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('re-triggered after a refusal: uses the next idempotency key', async () => {
    mockPrisma.payoutSettlement.upsert.mockResolvedValue(settlement({
      status: 'gateway_failed', gatewayResponse: JSON.stringify({ refusedPayoutIds: ['pout_bad'] }),
    }));
    mockInitiate.mockResolvedValue({ success: true, payoutId: 'pout_2', status: 'processed' });

    await processPayoutJob(job);

    expect(mockInitiate).toHaveBeenCalledWith(payment, 5, { idempotencyKey: 'payout_payment_77_r1' });
  });

  test('a network/HTTP error keeps the same key and rethrows so the job retries', async () => {
    mockPrisma.payoutSettlement.upsert.mockResolvedValue(settlement({ status: 'gateway_failed' }));
    mockInitiate.mockResolvedValue({ success: false, error: 'HTTP 503' });

    await expect(processPayoutJob(job)).rejects.toThrow('HTTP 503');
    expect(mockInitiate).toHaveBeenCalledWith(payment, 5, { idempotencyKey: 'payout_payment_77' });
  });

  test('another run already settled it (count 0): no second notification', async () => {
    mockPrisma.payoutSettlement.upsert.mockResolvedValue(settlement());
    mockInitiate.mockResolvedValue({ success: true, payoutId: 'pout_1', status: 'processed' });
    mockPrisma.payoutSettlement.updateMany.mockResolvedValue({ count: 0 });

    await processPayoutJob(job);
    expect(mockNotify).not.toHaveBeenCalled();
  });
});

describe('payout already accepted on a prior attempt', () => {
  test('checks its status and never creates another payout', async () => {
    mockPrisma.payoutSettlement.upsert.mockResolvedValue(settlement({ status: 'gateway_confirmed', gatewayPayoutId: 'pout_1' }));
    mockFetchPayout.mockResolvedValue({ id: 'pout_1', status: 'processed' });

    await processPayoutJob(job);

    expect(mockInitiate).not.toHaveBeenCalled();
    expect(mockFetchPayout).toHaveBeenCalledWith('pout_1');
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  test('still processing: left for the next check', async () => {
    mockPrisma.payoutSettlement.upsert.mockResolvedValue(settlement({ status: 'gateway_confirmed', gatewayPayoutId: 'pout_1' }));
    mockFetchPayout.mockResolvedValue({ id: 'pout_1', status: 'processing' });

    await processPayoutJob(job);

    expect(mockInitiate).not.toHaveBeenCalled();
    expect(mockPrisma.payoutSettlement.updateMany).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('reversed later: marked refused, payment failed', async () => {
    mockPrisma.payoutSettlement.upsert.mockResolvedValue(settlement({ status: 'gateway_confirmed', gatewayPayoutId: 'pout_1' }));
    mockFetchPayout.mockResolvedValue({ id: 'pout_1', status: 'reversed', status_details: { description: 'bank down' } });

    await processPayoutJob(job);

    expect(mockPrisma.payoutSettlement.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'gateway_failed', gatewayResponse: JSON.stringify({ refusedPayoutIds: ['pout_1'] }) }),
    }));
    expect(mockPrisma.payment.update).toHaveBeenCalledWith({ where: { id: 77 }, data: { vendorPayoutStatus: 'failed' } });
  });

  test('a status-check error rethrows (job retries) and still creates nothing', async () => {
    mockPrisma.payoutSettlement.upsert.mockResolvedValue(settlement({ status: 'reconciliation_needed', gatewayPayoutId: 'pout_1' }));
    mockFetchPayout.mockRejectedValue(new Error('timeout'));

    await expect(processPayoutJob(job)).rejects.toThrow('timeout');
    expect(mockInitiate).not.toHaveBeenCalled();
  });

  test('accepted with no payout id: stops for manual reconciliation', async () => {
    mockPrisma.payoutSettlement.upsert.mockResolvedValue(settlement({ status: 'gateway_confirmed', gatewayPayoutId: null }));

    await processPayoutJob(job);
    expect(mockInitiate).not.toHaveBeenCalled();
    expect(mockFetchPayout).not.toHaveBeenCalled();
  });
});

describe('reconcileInFlightPayouts', () => {
  test('re-checks each in-flight payout and survives a failing one', async () => {
    mockPrisma.payoutSettlement.findMany.mockResolvedValue([
      { paymentId: 77, payment: { bookingId: 9, booking: { service: { vendorId: 5 } } } },
      { paymentId: 78, payment: { bookingId: 10, booking: { service: { vendorId: 6 } } } },
      { paymentId: 79, payment: { bookingId: 11, booking: { service: null } } },
    ]);
    // 77 fails to load, 78 is processed.
    mockPrisma.payment.findUnique
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValueOnce({ ...payment, id: 78 });
    mockPrisma.payoutSettlement.upsert.mockResolvedValue(settlement({ paymentId: 78, status: 'gateway_confirmed', gatewayPayoutId: 'pout_78' }));
    mockFetchPayout.mockResolvedValue({ id: 'pout_78', status: 'processed' });

    await expect(reconcileInFlightPayouts()).resolves.toEqual({ checked: 3 });
    expect(mockPrisma.payoutSettlement.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: 'gateway_confirmed', gatewayPayoutId: { not: null } },
    }));
    expect(mockFetchPayout).toHaveBeenCalledWith('pout_78');
    expect(mockPrisma.payment.findUnique).toHaveBeenCalledTimes(2); // 79 has no vendor, skipped
  });

  test('a failed query returns checked 0 instead of throwing', async () => {
    mockPrisma.payoutSettlement.findMany.mockRejectedValue(new Error('db down'));
    await expect(reconcileInFlightPayouts()).resolves.toEqual({ checked: 0 });
  });
});

// A refund or cancellation can land while the job waits in the queue. The
// worker must re-check right before money moves (2026-11-03 review).
describe("last check before sending", () => {
  beforeEach(() => {
    mockPrisma.payoutSettlement.upsert.mockResolvedValue(settlement());
  });

  const expectStopped = (reason) => {
    expect(mockInitiate).not.toHaveBeenCalled();
    expect(mockPrisma.payoutSettlement.update).toHaveBeenCalledWith({
      where: { paymentId: 77 },
      data: { status: "gateway_failed", lastError: expect.stringContaining(reason) },
    });
    expect(mockPrisma.payment.update).toHaveBeenCalledWith({ where: { id: 77 }, data: { vendorPayoutStatus: "pending" } });
    expect(mockNotify).not.toHaveBeenCalled();
  };

  it("stops when a refund is still open", async () => {
    mockPrisma.refund.findFirst.mockResolvedValue({ id: 3, status: "gateway_confirmed" });
    await processPayoutJob(job);
    expectStopped("refund 3 is gateway_confirmed");
    expect(mockPrisma.refund.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { paymentId: 77, status: { in: ["initiated", "gateway_confirmed", "reconciliation_needed"] } },
    }));
  });

  it("stops when the booking was cancelled", async () => {
    mockPrisma.payment.findUnique.mockResolvedValue({ ...payment, booking: { ...payment.booking, status: "cancelled" } });
    await processPayoutJob(job);
    expectStopped("booking is cancelled");
  });

  it("stops when the payment was fully refunded", async () => {
    mockPrisma.payment.findUnique.mockResolvedValue({ ...payment, status: "refunded" });
    await processPayoutJob(job);
    expectStopped("payment is refunded");
  });

  it("stops when the job is not finished", async () => {
    mockPrisma.payment.findUnique.mockResolvedValue({ ...payment, booking: { ...payment.booking, status: "in_progress" } });
    await processPayoutJob(job);
    expectStopped("job not finished");
  });

  it("does not re-check a payout RazorpayX already accepted (never strands real money)", async () => {
    mockPrisma.payment.findUnique.mockResolvedValue({ ...payment, booking: { ...payment.booking, status: "cancelled" } });
    mockPrisma.payoutSettlement.upsert.mockResolvedValue(settlement({ status: "gateway_confirmed", gatewayPayoutId: "pout_1" }));
    mockFetchPayout.mockResolvedValue({ id: "pout_1", status: "processed" });
    await processPayoutJob(job);
    expect(mockFetchPayout).toHaveBeenCalledWith("pout_1");
    expect(mockInitiate).not.toHaveBeenCalled();
  });
});
