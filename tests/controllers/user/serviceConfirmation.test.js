import { jest } from '@jest/globals';

// Define mocks first using unstable_mockModule
jest.unstable_mockModule('../../../util/prisma.js', () => ({
  default: {
    booking: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    payment: {
      update: jest.fn(),
    },
    review: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

jest.unstable_mockModule('../../../queues/payoutQueue.js', () => ({
  addPayoutJob: jest.fn(),
}));

jest.unstable_mockModule('../../../util/notificationHelper.js', () => ({
  createNotification: jest.fn(),
  sendPushNotification: jest.fn(),
}));

jest.unstable_mockModule('../../../util/ratingHelper.js', () => ({
  updateVendorRatingStats: jest.fn(),
}));

// Import them after mocking
const { confirmServiceCompletion } = await import('../../../controllers/user/serviceConfirmationController.js');
const prisma = (await import('../../../util/prisma.js')).default;
const { addPayoutJob } = await import('../../../queues/payoutQueue.js');

describe('confirmServiceCompletion', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      params: { userId: '1', id: '100' },
      body: { confirmed: true, rating: 5, comment: 'Great job!' },
      user: { id: 1 },
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  test('should return 400 if bookingId is invalid', async () => {
    req.params.id = 'abc';
    await confirmServiceCompletion(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid user or booking ID' });
  });

  test('should return 404 if booking not found', async () => {
    prisma.booking.findUnique.mockResolvedValue(null);
    await confirmServiceCompletion(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Booking not found' });
  });

  test('should return 403 if user does not own booking', async () => {
    // req.user.id is 1; booking belongs to a different user (2) --
    // ownership must be checked against the authenticated user, not a param.
    prisma.booking.findUnique.mockResolvedValue({ userId: 2 });
    await confirmServiceCompletion(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: 'Not authorized to confirm this booking' });
  });

  test('should return 400 if booking status is not service_completed', async () => {
    prisma.booking.findUnique.mockResolvedValue({ userId: 1, status: 'pending' });
    await confirmServiceCompletion(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ 
      message: expect.stringContaining('Vendor must mark service as completed') 
    }));
  });

  test('Successful confirmation with payout and review', async () => {
    const mockBooking = {
      id: 100,
      userId: 1,
      status: 'service_completed',
      service: { vendorId: 10, name: 'Plumbing' },
      payment: { id: 50, status: 'success', vendorAmount: 400, platformFee: 100, vendorPayoutStatus: 'pending' }
    };

    prisma.booking.findUnique.mockResolvedValue(mockBooking);

    prisma.$transaction.mockImplementation(async (callback) => {
      const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]), // row lock taken inside the transaction
        // The status write is a guarded updateMany (WHERE status is still
        // service_completed) so a concurrent dispute wins; count 1 = no race.
        booking: { findUnique: jest.fn().mockResolvedValue(mockBooking), update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        payment: { update: jest.fn() },
        review: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
        // Confirmation refuses to release a payout while a refund is reserved
        // against the payment, checked under the same row lock. Default is
        // "no refund in progress" so the happy path behaves as before.
        refund: { findFirst: jest.fn().mockResolvedValue(null) }
      };

      return await callback(tx);
    });

    await confirmServiceCompletion(req, res);

    expect(prisma.$transaction).toHaveBeenCalled();
    // addPayoutJob now also receives `tx` (F42 fix: enqueued INSIDE the
    // transaction so an enqueue failure can't strand the payment in
    // "processing" with no job to move it) -- second arg not asserted here.
    expect(addPayoutJob).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: mockBooking.payment.id,
        vendorId: mockBooking.service.vendorId,
        bookingId: mockBooking.id,
      }),
      expect.anything()
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      message: expect.stringContaining('Service confirmed')
    }));
  });

  test('No Payment row (pay at the garage): closes as user_confirmed, no payout', async () => {
    let txUsed;
    const mockBooking = {
      id: 100,
      userId: 1,
      status: 'service_completed',
      service: { vendorId: 10, name: 'Plumbing' },
      payment: null
    };

    prisma.booking.findUnique.mockResolvedValue(mockBooking);
    
    prisma.$transaction.mockImplementation(async (callback) => {
      const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]), // row lock taken inside the transaction
        booking: { findUnique: jest.fn().mockResolvedValue(mockBooking), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        review: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
        payment: { update: jest.fn() },
      };
      await callback(tx);
      txUsed = tx;
    });

    await confirmServiceCompletion(req, res);

    // Pay-at-garage (2026-11-22): no Payment row is normal, so this now closes the booking (no payout).
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(txUsed.booking.updateMany).toHaveBeenCalledWith({ where: { id: 100, status: 'service_completed' }, data: { status: 'user_confirmed' } });
    expect(txUsed.payment.update).not.toHaveBeenCalled();
  });

  // Owner decision 2026-11-21: a v2 booking closed by a paid ₹0 bill has no
  // Payment row; confirming must close it without any payout.
  test('₹0 paid bill, no Payment row: confirms, records review, no payout queued', async () => {
    const mockBooking = { id: 100, userId: 1, status: 'service_completed', service: { vendorId: 10, name: 'Inspection' }, payment: null };
    prisma.booking.findUnique.mockResolvedValue(mockBooking);
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      booking: { findUnique: jest.fn().mockResolvedValue(mockBooking), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      finalBill: { findFirst: jest.fn().mockResolvedValue({ id: 7 }) },
      review: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      payment: { update: jest.fn() },
      refund: { findFirst: jest.fn() },
    };
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));

    await confirmServiceCompletion(req, res);

    expect(tx.booking.updateMany).toHaveBeenCalledWith({ where: { id: 100, status: 'service_completed' }, data: { status: 'user_confirmed' } });
    expect(tx.review.create).toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.refund.findFirst).not.toHaveBeenCalled();
    expect(addPayoutJob).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(400);
    // Why: no Payment row means no payout, so the reply must not claim one is processing.
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Service confirmed.', booking: expect.objectContaining({ payoutStatus: 'none' }) }));
    expect(res.status).not.toHaveBeenCalledWith(500);
  });
});
