import { jest } from '@jest/globals';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = {
  backgroundJob: {
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  $queryRaw: jest.fn(),
};

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: mockPrisma,
}));

jest.unstable_mockModule('../../util/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  enqueueJob,
  registerJobHandler,
  runDueJobs,
  reclaimStuckJobs,
  pruneCompletedJobs,
  JOB_TYPES,
} = await import('../../util/jobQueue.js');

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.backgroundJob.create.mockResolvedValue({ id: 1 });
  mockPrisma.backgroundJob.update.mockResolvedValue({});
});

// ─── enqueueJob ───────────────────────────────────────────────────────────────

describe('enqueueJob', () => {
  test('creates a pending row with the payload and attempt budget', async () => {
    await enqueueJob(JOB_TYPES.NOTIFICATION, { recipientId: 5 }, { maxAttempts: 3 });

    expect(mockPrisma.backgroundJob.create).toHaveBeenCalledWith({
      data: { type: 'notification', payload: { recipientId: 5 }, maxAttempts: 3 },
      select: { id: true },
    });
  });

  test('defaults to 3 attempts when not specified', async () => {
    await enqueueJob(JOB_TYPES.NOTIFICATION, {});

    expect(mockPrisma.backgroundJob.create.mock.calls[0][0].data.maxAttempts).toBe(3);
  });

  test('passes runAt through when a delay is requested', async () => {
    const runAt = new Date('2030-01-01T00:00:00Z');
    await enqueueJob(JOB_TYPES.VENDOR_PAYOUT, {}, { runAt });

    expect(mockPrisma.backgroundJob.create.mock.calls[0][0].data.runAt).toBe(runAt);
  });
});

// ─── runDueJobs ───────────────────────────────────────────────────────────────

describe('runDueJobs', () => {
  test('does nothing when no jobs are due', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);

    const processed = await runDueJobs();

    expect(processed).toBe(0);
    expect(mockPrisma.backgroundJob.update).not.toHaveBeenCalled();
  });

  test('runs the registered handler and marks the job completed', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    registerJobHandler('test-ok', handler);
    mockPrisma.$queryRaw.mockResolvedValue([
      { id: 11, type: 'test-ok', payload: { a: 1 }, attempts: 0, maxAttempts: 3 },
    ]);

    const processed = await runDueJobs();

    expect(processed).toBe(1);
    // Shaped like a BullMQ job, so existing processors need no changes.
    expect(handler).toHaveBeenCalledWith({ id: 11, data: { a: 1 } });
    expect(mockPrisma.backgroundJob.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { status: 'completed', attempts: 1 },
    });
  });

  test('reschedules a failed job as pending with a future runAt', async () => {
    registerJobHandler('test-fail', jest.fn().mockRejectedValue(new Error('boom')));
    mockPrisma.$queryRaw.mockResolvedValue([
      { id: 12, type: 'test-fail', payload: {}, attempts: 0, maxAttempts: 3 },
    ]);

    await runDueJobs();

    const data = mockPrisma.backgroundJob.update.mock.calls[0][0].data;
    expect(data.status).toBe('pending');
    expect(data.attempts).toBe(1);
    expect(data.lastError).toContain('boom');
    expect(data.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('marks the job failed once the attempt budget is exhausted', async () => {
    registerJobHandler('test-fail', jest.fn().mockRejectedValue(new Error('boom')));
    mockPrisma.$queryRaw.mockResolvedValue([
      { id: 13, type: 'test-fail', payload: {}, attempts: 2, maxAttempts: 3 },
    ]);

    await runDueJobs();

    const data = mockPrisma.backgroundJob.update.mock.calls[0][0].data;
    expect(data.status).toBe('failed');
    expect(data.attempts).toBe(3);
    expect(data.runAt).toBeUndefined();
  });

  test('backoff grows with the attempt count', async () => {
    registerJobHandler('test-fail', jest.fn().mockRejectedValue(new Error('boom')));

    mockPrisma.$queryRaw.mockResolvedValue([
      { id: 14, type: 'test-fail', payload: {}, attempts: 0, maxAttempts: 9 },
    ]);
    await runDueJobs();
    const first = mockPrisma.backgroundJob.update.mock.calls[0][0].data.runAt.getTime();

    jest.clearAllMocks();
    mockPrisma.backgroundJob.update.mockResolvedValue({});
    mockPrisma.$queryRaw.mockResolvedValue([
      { id: 14, type: 'test-fail', payload: {}, attempts: 4, maxAttempts: 9 },
    ]);
    await runDueJobs();
    const later = mockPrisma.backgroundJob.update.mock.calls[0][0].data.runAt.getTime();

    expect(later).toBeGreaterThan(first);
  });

  // An unknown type is a deployment mistake, not a transient fault, so it must
  // not be retried forever.
  test('fails a job outright when no handler is registered for its type', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      { id: 15, type: 'nobody-handles-this', payload: {}, attempts: 0, maxAttempts: 3 },
    ]);

    await runDueJobs();

    const call = mockPrisma.backgroundJob.update.mock.calls[0][0];
    expect(call.data.status).toBe('failed');
    expect(call.data.lastError).toContain('No handler registered');
  });

  // A throwing dispatcher would kill the cron tick driving it, silently
  // stopping all background work.
  test('never throws when the claim query fails', async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error('db down'));

    await expect(runDueJobs()).resolves.toBe(0);
  });

  test('one failing job does not prevent the rest of the batch running', async () => {
    const ok = jest.fn().mockResolvedValue(undefined);
    registerJobHandler('test-ok', ok);
    registerJobHandler('test-fail', jest.fn().mockRejectedValue(new Error('boom')));
    mockPrisma.$queryRaw.mockResolvedValue([
      { id: 16, type: 'test-fail', payload: {}, attempts: 0, maxAttempts: 3 },
      { id: 17, type: 'test-ok', payload: {}, attempts: 0, maxAttempts: 3 },
    ]);

    const processed = await runDueJobs();

    expect(processed).toBe(2);
    expect(ok).toHaveBeenCalled();
  });
});

// ─── Housekeeping ─────────────────────────────────────────────────────────────

describe('reclaimStuckJobs', () => {
  test('returns jobs stranded in processing back to pending', async () => {
    mockPrisma.backgroundJob.updateMany.mockResolvedValue({ count: 2 });

    const count = await reclaimStuckJobs(60_000);

    expect(count).toBe(2);
    const where = mockPrisma.backgroundJob.updateMany.mock.calls[0][0].where;
    expect(where.status).toBe('processing');
    expect(where.updatedAt.lt).toBeInstanceOf(Date);
  });

  test('never throws when the database is unreachable', async () => {
    mockPrisma.backgroundJob.updateMany.mockRejectedValue(new Error('db down'));

    await expect(reclaimStuckJobs()).resolves.toBe(0);
  });
});

describe('pruneCompletedJobs', () => {
  // Failed rows are kept deliberately: they are the operator's audit trail.
  test('deletes only completed rows past the retention window', async () => {
    mockPrisma.backgroundJob.deleteMany.mockResolvedValue({ count: 5 });

    const count = await pruneCompletedJobs(1000);

    expect(count).toBe(5);
    expect(mockPrisma.backgroundJob.deleteMany.mock.calls[0][0].where.status).toBe('completed');
  });

  test('never throws when the database is unreachable', async () => {
    mockPrisma.backgroundJob.deleteMany.mockRejectedValue(new Error('db down'));

    await expect(pruneCompletedJobs()).resolves.toBe(0);
  });
});
