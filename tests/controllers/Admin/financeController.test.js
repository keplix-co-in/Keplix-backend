import { jest } from '@jest/globals';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = {
  payment: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn(),
};

jest.unstable_mockModule('../../../util/prisma.js', () => ({
  default: mockPrisma,
}));

const mockAddPayoutJob = jest.fn();
jest.unstable_mockModule('../../../queues/payoutQueue.js', () => ({
  addPayoutJob: mockAddPayoutJob,
}));

const { settlePayout } = await import('../../../controllers/Admin/financeController.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockReq(id) {
  return { params: { id } };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function basePayment(overrides = {}) {
  return {
    id: 1,
    status: 'success',
    vendorPayoutStatus: 'pending',
    vendorAmount: 500,
    bookingId: 10,
    booking: { service: { vendorId: 42 } },
    ...overrides,
  };
}

/**
 * Wires mockPrisma.$transaction so the callback runs against a `tx` whose
 * payment.findUnique/update reflect the given payment + a spy for updates.
 */
function wireTransaction(payment) {
  const txUpdates = [];
  const tx = {
    payment: {
      findUnique: jest.fn().mockResolvedValue(payment),
      update: jest.fn().mockImplementation(async ({ where, data }) => {
        txUpdates.push({ where, data });
        return { ...payment, ...data };
      }),
    },
  };
  mockPrisma.$transaction.mockImplementation(async (cb) => cb(tx));
  return { tx, txUpdates };
}

describe('settlePayout', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns 400 for a non-numeric/invalid payment id', async () => {
    const res = mockRes();
    await settlePayout(mockReq('abc'), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: 'Invalid payment id' })
    );
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 404 when the payment does not exist', async () => {
    wireTransaction(null);
    const res = mockRes();

    await settlePayout(mockReq('1'), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: 'Payment not found' })
    );
    expect(mockAddPayoutJob).not.toHaveBeenCalled();
  });

  it('returns 400 when payment.status is not "success"', async () => {
    wireTransaction(basePayment({ status: 'pending' }));
    const res = mockRes();

    await settlePayout(mockReq('1'), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Payment not successful' })
    );
  });

  it('returns 400 when already settled ("settled")', async () => {
    wireTransaction(basePayment({ vendorPayoutStatus: 'settled' }));
    const res = mockRes();

    await settlePayout(mockReq('1'), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Already settled!' })
    );
  });

  it('returns 400 when already settled ("paid")', async () => {
    wireTransaction(basePayment({ vendorPayoutStatus: 'paid' }));
    const res = mockRes();

    await settlePayout(mockReq('1'), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Already settled!' })
    );
  });

  it('returns 400 when a payout is already in flight ("processing") -- the race-condition guard', async () => {
    const { txUpdates } = wireTransaction(basePayment({ vendorPayoutStatus: 'processing' }));
    const res = mockRes();

    await settlePayout(mockReq('1'), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Payout already in progress' })
    );
    // Must NOT re-lock/re-enqueue an already in-flight payout
    expect(txUpdates.length).toBe(0);
    expect(mockAddPayoutJob).not.toHaveBeenCalled();
  });

  it('returns 400 for a zero/invalid vendor amount', async () => {
    wireTransaction(basePayment({ vendorAmount: 0 }));
    const res = mockRes();

    await settlePayout(mockReq('1'), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Zero amount or invalid vendor amount' })
    );
  });

  it('returns 400 when the booking has no resolvable vendor', async () => {
    wireTransaction(basePayment({ booking: { service: {} } }));
    const res = mockRes();

    await settlePayout(mockReq('1'), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Vendor not found for booking' })
    );
  });

  it('locks the row to "processing" inside the transaction before queueing', async () => {
    const { txUpdates } = wireTransaction(basePayment());
    const res = mockRes();

    await settlePayout(mockReq('1'), res);

    expect(txUpdates).toEqual([
      { where: { id: 1 }, data: { vendorPayoutStatus: 'processing' } },
    ]);
  });

  it('enqueues a BullMQ payout job with paymentId/vendorId/bookingId and responds 202', async () => {
    wireTransaction(basePayment());
    const res = mockRes();

    await settlePayout(mockReq('1'), res);

    expect(mockAddPayoutJob).toHaveBeenCalledWith({
      paymentId: 1,
      vendorId: 42,
      bookingId: 10,
    });
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        message: 'Payout queued for processing',
        payment: expect.objectContaining({ vendorPayoutStatus: 'processing' }),
      })
    );
  });

  it('never calls the payout gateway/queue synchronously from within the transaction', async () => {
    let queuedDuringTransaction = false;
    mockPrisma.$transaction.mockImplementation(async (cb) => {
      const tx = {
        payment: {
          findUnique: jest.fn().mockResolvedValue(basePayment()),
          update: jest.fn().mockImplementation(async ({ where, data }) => {
            if (mockAddPayoutJob.mock.calls.length > 0) queuedDuringTransaction = true;
            return { where, data };
          }),
        },
      };
      return cb(tx);
    });
    const res = mockRes();

    await settlePayout(mockReq('1'), res);

    expect(queuedDuringTransaction).toBe(false);
    expect(mockAddPayoutJob).toHaveBeenCalledTimes(1);
  });

  it('coerces a string payment id to a number', async () => {
    let queriedId = null;
    mockPrisma.$transaction.mockImplementation(async (cb) => {
      const tx = {
        payment: {
          findUnique: jest.fn().mockImplementation(async ({ where }) => {
            queriedId = where.id;
            return basePayment();
          }),
          update: jest.fn().mockResolvedValue({}),
        },
      };
      return cb(tx);
    });
    const res = mockRes();

    await settlePayout(mockReq('1'), res);

    expect(queriedId).toBe(1);
    expect(typeof queriedId).toBe('number');
  });

  it('returns 500 and does not enqueue a job if the transaction throws', async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error('DB connection lost'));
    const res = mockRes();

    await settlePayout(mockReq('1'), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: 'Failed to settle payout entirely' })
    );
    expect(mockAddPayoutJob).not.toHaveBeenCalled();
  });

  it('returns 500 if enqueueing the BullMQ job fails after the row was already locked', async () => {
    wireTransaction(basePayment());
    mockAddPayoutJob.mockRejectedValue(new Error('Redis unavailable'));
    const res = mockRes();

    await settlePayout(mockReq('1'), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('two concurrent settle attempts on the same payment: only the first succeeds', async () => {
    // Simulate the DB enforcing the lock: the payment mutates to "processing"
    // after the first transaction commits, so a second call sees it locked.
    let currentStatus = 'pending';
    mockPrisma.$transaction.mockImplementation(async (cb) => {
      const snapshot = basePayment({ vendorPayoutStatus: currentStatus });
      const tx = {
        payment: {
          findUnique: jest.fn().mockResolvedValue(snapshot),
          update: jest.fn().mockImplementation(async ({ data }) => {
            currentStatus = data.vendorPayoutStatus;
            return { ...snapshot, ...data };
          }),
        },
      };
      return cb(tx);
    });

    const res1 = mockRes();
    const res2 = mockRes();

    await settlePayout(mockReq('1'), res1);
    await settlePayout(mockReq('1'), res2);

    expect(res1.status).toHaveBeenCalledWith(202);
    expect(res2.status).toHaveBeenCalledWith(400);
    expect(res2.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Payout already in progress' })
    );
    expect(mockAddPayoutJob).toHaveBeenCalledTimes(1);
  });
});
