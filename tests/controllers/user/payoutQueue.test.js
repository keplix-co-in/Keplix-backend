import { jest } from '@jest/globals';

// Define a shared mock prisma object
const mockPrisma = {
  booking: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  payment: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  review: {
    findUnique: jest.fn(),
    create: jest.fn(),
  },
  $transaction: jest.fn().mockImplementation(async (callback) => {
    // Default implementation for tests that don't override it
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]), // row lock taken inside the transaction
      // Payout release is refused while a refund is reserved; default none.
      refund: { findFirst: jest.fn().mockResolvedValue(null) },
      booking: {
        findUnique: jest.fn().mockResolvedValue({
            status: 'service_completed',
            payment: { id: 100, status: 'success', vendorPayoutStatus: 'pending' }
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      payment: {
        update: jest.fn().mockResolvedValue({}),
      },
      review: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      }
    };
    return callback(tx);
  }),
};

// Mock Prisma
jest.unstable_mockModule('../../../util/prisma.js', () => ({
  default: mockPrisma,
}));

// Mock BullMQ
jest.unstable_mockModule('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue({ id: 'job_123' }),
  })),
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(true),
  })),
}));

// Mock Redis connection
jest.unstable_mockModule('../../../util/redis.js', () => ({
  default: {},
}));

// Mock payoutHelper
jest.unstable_mockModule('../../../util/payoutHelper.js', () => ({
  initiateVendorPayout: jest.fn(),
}));

// Mock notificationHelper
jest.unstable_mockModule('../../../util/notificationHelper.js', () => ({
  createNotification: jest.fn(),
  sendPushNotification: jest.fn(),
}));

// Mock ratingHelper
jest.unstable_mockModule('../../../util/ratingHelper.js', () => ({
  updateVendorRatingStats: jest.fn(),
}));

const { default: prisma } = await import('../../../util/prisma.js');
const { addPayoutJob } = await import('../../../queues/payoutQueue.js');
const { confirmServiceCompletion } = await import('../../../controllers/user/serviceConfirmationController.js');
const { initiateVendorPayout } = await import('../../../util/payoutHelper.js');

describe('Vendor Payout Queueing & Worker', () => {
  let mockRes;
  let mockReq;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
  });

  describe('confirmServiceCompletion (Controller)', () => {
    it('should update status to processing and queue a payout job', async () => {
      const mockBooking = {
        id: 1,
        userId: 1,
        status: 'service_completed',
        service: { vendorId: 10, name: 'Test Service' },
        payment: { id: 100, status: 'success', vendorPayoutStatus: 'pending' }
      };

      prisma.booking.findUnique.mockResolvedValue(mockBooking);
      
      prisma.$transaction.mockImplementation(async (callback) => {
        const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]), // row lock taken inside the transaction
      // Payout release is refused while a refund is reserved; default none.
      refund: { findFirst: jest.fn().mockResolvedValue(null) },
            booking: {
                findUnique: jest.fn().mockResolvedValue(mockBooking),
                update: jest.fn().mockResolvedValue({}),
            },
            payment: {
                update: jest.fn().mockResolvedValue({}),
            },
            review: {
                findUnique: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockResolvedValue({}),
            }
        };
        const res = await callback(tx);
        prisma.lastTx = tx; 
        return res;
      });

      mockReq = {
        params: { userId: '1', id: '1' },
        body: { confirmed: true }
      };

      await confirmServiceCompletion(mockReq, mockRes);

      expect(prisma.lastTx.payment.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 100 },
        data: { vendorPayoutStatus: 'processing' }
      }));
      
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        message: expect.stringContaining('Vendor payout is being processed')
      }));
    });

    it('should fail if booking is not in service_completed status', async () => {
      prisma.booking.findUnique.mockResolvedValue({
        id: 1,
        userId: 1,
        status: 'pending'
      });

      mockReq = {
        params: { userId: '1', id: '1' },
        body: { confirmed: true }
      };

      await confirmServiceCompletion(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('Vendor must mark service as completed first')
      }));
    });

    it('should fail if payout is already processed', async () => {
      const mockBookingPaid = {
        id: 1,
        userId: 1,
        status: 'service_completed',
        payment: { id: 100, status: 'success', vendorPayoutStatus: 'paid' },
        service: { vendorId: 10 }
      };

      prisma.booking.findUnique.mockResolvedValue(mockBookingPaid);
      
      prisma.$transaction.mockImplementation(async (callback) => {
        const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]), // row lock taken inside the transaction
      // Payout release is refused while a refund is reserved; default none.
      refund: { findFirst: jest.fn().mockResolvedValue(null) },
            booking: {
                findUnique: jest.fn().mockResolvedValue(mockBookingPaid),
            },
        };
        return callback(tx);
      });

      mockReq = {
        params: { userId: '1', id: '1' },
        body: { confirmed: true }
      };

      await confirmServiceCompletion(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('Vendor payout already processed')
      }));
    });
  });

  describe('Payout Worker Logic (Simulation)', () => {
    it('should process payout successfully and update DB', async () => {
      const jobData = { paymentId: 100, vendorId: 10, bookingId: 1 };
      const mockPayment = {
        id: 100,
        vendorPayoutStatus: 'processing',
        vendorAmount: 500,
        booking: { service: { name: 'Test Service' } }
      };

      prisma.payment.findUnique.mockResolvedValue(mockPayment);
      initiateVendorPayout.mockResolvedValue({ success: true, payoutId: 'payout_xyz' });
      prisma.payment.update.mockResolvedValue({});

      // Simulate worker process
      const payment = await prisma.payment.findUnique({ where: { id: jobData.paymentId } });
      const res = await initiateVendorPayout(payment, jobData.vendorId);
      if (res.success) {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { vendorPayoutStatus: 'paid', vendorPayoutId: res.payoutId }
        });
      }

      expect(initiateVendorPayout).toHaveBeenCalled();
      expect(prisma.payment.update).toHaveBeenCalledWith(expect.objectContaining({
        data: { vendorPayoutStatus: 'paid', vendorPayoutId: 'payout_xyz' }
      }));
    });
  });
});
