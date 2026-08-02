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

jest.unstable_mockModule('../../../util/payoutHelper.js', () => ({
  initiateVendorPayout: jest.fn(),
}));

jest.unstable_mockModule('../../../util/notificationHelper.js', () => ({
  createNotification: jest.fn(),
}));

jest.unstable_mockModule('../../../util/ratingHelper.js', () => ({
  updateVendorRatingStats: jest.fn(),
}));

// Import them after mocking
const { confirmServiceCompletion } = await import('../../../controllers/user/serviceConfirmationController.js');
const prisma = (await import('../../../util/prisma.js')).default;
const { initiateVendorPayout } = await import('../../../util/payoutHelper.js');
const { createNotification } = await import('../../../util/notificationHelper.js');

describe('confirmServiceCompletion', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      params: { userId: '1', id: '100' },
      body: { confirmed: true, rating: 5, comment: 'Great job!' },
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  test('should return 400 if userId or bookingId is invalid', async () => {
    req.params.userId = 'abc';
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
        booking: { findUnique: jest.fn().mockResolvedValue(mockBooking), update: jest.fn() },
        payment: { update: jest.fn() },
        review: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() }
      };
      
      initiateVendorPayout.mockResolvedValue({ success: true, payoutId: 'payout_123' });
      
      return await callback(tx);
    });

    await confirmServiceCompletion(req, res);

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(initiateVendorPayout).toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      message: expect.stringContaining('Service confirmed')
    }));
  });

  test('Rollback scenario: Missing payment record', async () => {
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
        booking: { findUnique: jest.fn().mockResolvedValue(mockBooking) }
      };
      await callback(tx);
    });

    await confirmServiceCompletion(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'No payment found for this booking' });
  });
});
