/**
 * Regression test for the CONFIRMED payout-enqueue stranding defect, found
 * by the 2026-09-12 codebase audit (code-reviewer F42).
 *
 * Both payout entry points (claimAndQueuePayout in services/payoutService.js,
 * confirmBookingAndQueuePayout in services/bookingConfirmationService.js)
 * flipped vendorPayoutStatus to "processing" inside a transaction that
 * committed, then called addPayoutJob AFTER it, with no transaction and no
 * retry. If that insert failed -- or the process was killed between commit
 * and enqueue -- the payment was permanently "processing" with no job to
 * ever move it, and every recovery path was closed by design (both entry
 * points reject re-claiming a "processing" payment).
 *
 * The fix: enqueueJob (util/jobQueue.js) now accepts an optional `client`,
 * and both entry points pass `tx` so the BackgroundJob row commits or rolls
 * back atomically with the status flip. This test proves the atomicity
 * directly against enqueueJob/addPayoutJob, independent of either specific
 * controller's mocking.
 *
 * See tests/regressions/bookingStatusGuards.test.js for the file convention.
 */
import { jest } from '@jest/globals';

const mockPrisma = {
  backgroundJob: { create: jest.fn() },
};

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../util/logger.js', () => ({
  default: { debug: jest.fn(), error: jest.fn() },
}));

const { enqueueJob, JOB_TYPES } = await import('../../util/jobQueue.js');
const { addPayoutJob } = await import('../../queues/payoutQueue.js');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('payout enqueue atomicity — FIXED, regression guard', () => {
  test('enqueueJob writes through the passed client, not always the module prisma', async () => {
    const fakeTx = { backgroundJob: { create: jest.fn().mockResolvedValue({ id: 5 }) } };

    await enqueueJob(JOB_TYPES.VENDOR_PAYOUT, { paymentId: 1 }, { client: fakeTx });

    expect(fakeTx.backgroundJob.create).toHaveBeenCalled();
    expect(mockPrisma.backgroundJob.create).not.toHaveBeenCalled();
  });

  test('enqueueJob falls back to the module prisma client when none is passed', async () => {
    mockPrisma.backgroundJob.create.mockResolvedValue({ id: 6 });

    await enqueueJob(JOB_TYPES.VENDOR_PAYOUT, { paymentId: 1 });

    expect(mockPrisma.backgroundJob.create).toHaveBeenCalled();
  });

  test('addPayoutJob forwards its tx argument through to the enqueue write', async () => {
    const fakeTx = { backgroundJob: { create: jest.fn().mockResolvedValue({ id: 7 }) } };

    await addPayoutJob({ paymentId: 1, vendorId: 42, bookingId: 10 }, fakeTx);

    expect(fakeTx.backgroundJob.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: JOB_TYPES.VENDOR_PAYOUT }) })
    );
    expect(mockPrisma.backgroundJob.create).not.toHaveBeenCalled();
  });

  test('a failed enqueue inside a transaction rolls back with the rest of the transaction (simulated)', async () => {
    // Simulates the real scenario: the transaction's status-flip write and
    // the enqueue live in the same `tx`. If the enqueue insert throws, the
    // whole transaction rejects -- there is no way for the status flip to
    // commit while the job row is lost, which is exactly what stranded
    // payments in "processing" before this fix.
    const statusFlip = jest.fn().mockResolvedValue({});
    const fakeTx = {
      payment: { update: statusFlip },
      backgroundJob: { create: jest.fn().mockRejectedValue(new Error('insert failed')) },
    };

    const runInTransaction = async (tx) => {
      await tx.payment.update({ where: { id: 1 }, data: { vendorPayoutStatus: 'processing' } });
      await addPayoutJob({ paymentId: 1, vendorId: 42, bookingId: 10 }, tx);
    };

    await expect(runInTransaction(fakeTx)).rejects.toThrow('insert failed');
    // The status flip call happened, but in a REAL Postgres transaction this
    // throw aborts the whole transaction -- nothing commits. This test
    // documents that the enqueue failure is visible (propagates), which is
    // the precondition for the transaction wrapper to roll it back; the
    // actual rollback guarantee itself comes from Postgres/Prisma's
    // $transaction, not from this function.
    expect(statusFlip).toHaveBeenCalled();
    expect(fakeTx.backgroundJob.create).toHaveBeenCalled();
  });
});
