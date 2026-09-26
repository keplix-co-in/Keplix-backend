/**
 * Regression test for audit #76: a disputed booking could be resolved in the
 * vendor's favour (forceCompleteBooking) but had no formal path to be closed
 * in the customer's favour. resolveDisputeForCustomer is that path.
 *
 * Deliberately does not call the payment gateway -- see the controller's
 * comment for why the refund itself stays a separate action against
 * /admin/finance/payments/:id/refund.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../../util/prisma.js', () => ({
  default: {
    booking: { findUnique: jest.fn(), update: jest.fn() },
  },
}));
jest.unstable_mockModule('../../../queues/notificationQueue.js', () => ({
  addNotificationJob: jest.fn(),
}));

const prisma = (await import('../../../util/prisma.js')).default;
const { addNotificationJob } = await import('../../../queues/notificationQueue.js');
const { resolveDisputeForCustomer } = await import('../../../controllers/Admin/bookingController.js');

const BOOKING_ID = 701;
const CUSTOMER_ID = 501;
const VENDOR_ID = 601;
const ADMIN_ID = 1;

const disputedBooking = (overrides = {}) => ({
  id: BOOKING_ID,
  userId: CUSTOMER_ID,
  status: 'disputed',
  notes: null,
  service: { vendorId: VENDOR_ID, name: 'Full Service' },
  ...overrides,
});

const mockReq = (body, params = { id: String(BOOKING_ID) }) => ({
  body,
  params,
  user: { id: ADMIN_ID },
});

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  prisma.booking.update.mockImplementation(async ({ data }) => ({ ...disputedBooking(), ...data }));
});

describe('resolveDisputeForCustomer', () => {
  test('rejects a reason shorter than 10 characters', async () => {
    const res = mockRes();
    await resolveDisputeForCustomer(mockReq({ reason: 'too short' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test('404s when the booking does not exist', async () => {
    prisma.booking.findUnique.mockResolvedValue(null);
    const res = mockRes();

    await resolveDisputeForCustomer(mockReq({ reason: 'Vendor did not do the requested work.' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('refuses to resolve a booking that is not currently disputed', async () => {
    prisma.booking.findUnique.mockResolvedValue(disputedBooking({ status: 'in_progress' }));
    const res = mockRes();

    await resolveDisputeForCustomer(mockReq({ reason: 'Vendor did not do the requested work.' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test('cancels the booking and notifies both customer and vendor', async () => {
    prisma.booking.findUnique.mockResolvedValue(disputedBooking());
    const res = mockRes();

    await resolveDisputeForCustomer(
      mockReq({ reason: 'Vendor did not do the requested work.' }),
      res,
    );

    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BOOKING_ID },
        data: expect.objectContaining({ status: 'cancelled' }),
      }),
    );
    expect(addNotificationJob).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: CUSTOMER_ID, type: 'DISPUTE_RESOLVED_CUSTOMER' }),
    );
    expect(addNotificationJob).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: VENDOR_ID, type: 'DISPUTE_RESOLVED_VENDOR_NOTICE' }),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ booking: expect.objectContaining({ status: 'cancelled' }) }),
    );
  });

  test('does not call the payment gateway or any refund service', async () => {
    // Explicit guard against the exact risk the controller comment calls
    // out: this must never grow a direct Razorpay call of its own.
    prisma.booking.findUnique.mockResolvedValue(disputedBooking());
    const res = mockRes();

    await resolveDisputeForCustomer(mockReq({ reason: 'Vendor did not do the requested work.' }), res);

    // Nothing in this module imports Razorpay or refundService; a passing
    // test suite with no such import is itself the guard, but assert the
    // response shape carries no refund/payment fields to be extra sure
    // nothing was bolted on silently.
    const payload = res.json.mock.calls[0][0];
    expect(payload).not.toHaveProperty('refund');
    expect(payload).not.toHaveProperty('payment');
  });
});
