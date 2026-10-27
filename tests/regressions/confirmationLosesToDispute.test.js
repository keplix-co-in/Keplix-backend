/**
 * Regression: a dispute that commits while a confirmation is in flight wins.
 *
 * confirmBookingAndQueuePayout locks the PAYMENT row, which a customer
 * dispute never touches, so a dispute could commit between the
 * confirmation's status read and its write. The write was an unconditional
 * update: 'disputed' was overwritten with 'user_confirmed' and the payout the
 * customer was objecting to was queued. It is now a guarded updateMany
 * (status still service_completed); count 0 throws, rolling back the whole
 * transaction -- no payout claim, no payout job. This matters more now that
 * the auto-confirm cron calls this function with nobody watching.
 *
 * Exercises the REAL service with mocked Prisma.
 */
import { jest } from '@jest/globals';

const tx = {
  $queryRaw: jest.fn(),
  refund: { findFirst: jest.fn() },
  booking: { findUnique: jest.fn(), updateMany: jest.fn() },
  payment: { update: jest.fn() },
  review: { findUnique: jest.fn(), create: jest.fn() },
};

const mockPrisma = {
  booking: { findUnique: jest.fn() },
  $transaction: jest.fn(async (cb) => cb(tx)),
};

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../queues/payoutQueue.js', () => ({ addPayoutJob: jest.fn() }));
jest.unstable_mockModule('../../util/ratingHelper.js', () => ({ updateVendorRatingStats: jest.fn() }));
jest.unstable_mockModule('../../services/refundService.js', () => ({
  RESERVED_STATUSES: ['pending', 'processing'],
}));

const { confirmBookingAndQueuePayout, BookingConfirmationError } = await import(
  '../../services/bookingConfirmationService.js'
);
const { addPayoutJob } = await import('../../queues/payoutQueue.js');

const USER_ID = 51;
const BOOKING_ID = 7001;

const completedBooking = () => ({
  id: BOOKING_ID,
  userId: USER_ID,
  status: 'service_completed',
  service: { vendorId: 61, name: 'Full Service' },
  payment: { id: 900, status: 'success', vendorPayoutStatus: 'pending' },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.booking.findUnique.mockResolvedValue(completedBooking());
  tx.$queryRaw.mockResolvedValue([]);
  tx.refund.findFirst.mockResolvedValue(null);
  tx.booking.findUnique.mockResolvedValue(completedBooking());
});

test('the confirmation write is guarded on service_completed', async () => {
  tx.booking.updateMany.mockResolvedValue({ count: 1 });

  await confirmBookingAndQueuePayout({ userId: USER_ID, bookingId: BOOKING_ID });

  expect(tx.booking.updateMany).toHaveBeenCalledWith({
    where: { id: BOOKING_ID, status: 'service_completed' },
    data: { status: 'user_confirmed' },
  });
  expect(addPayoutJob).toHaveBeenCalledTimes(1);
});

test('a dispute committing first (guarded count 0) is a 400 and no payout is claimed or queued', async () => {
  tx.booking.updateMany.mockResolvedValue({ count: 0 });

  const attempt = confirmBookingAndQueuePayout({ userId: USER_ID, bookingId: BOOKING_ID });

  await expect(attempt).rejects.toBeInstanceOf(BookingConfirmationError);
  await expect(
    confirmBookingAndQueuePayout({ userId: USER_ID, bookingId: BOOKING_ID }),
  ).rejects.toMatchObject({ statusCode: 400 });
  expect(tx.payment.update).not.toHaveBeenCalled();
  expect(addPayoutJob).not.toHaveBeenCalled();
});
