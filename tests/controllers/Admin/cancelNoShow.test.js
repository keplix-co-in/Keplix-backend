/**
 * DEV-26: admin "cancel no-show" for bookings stuck in in_progress.
 * Cancels (guarded on in_progress), voids a pending payout, leaves a
 * paid/settled payout alone, and issues a FULL refund via the existing
 * refundPolicy path (no direct gateway calls).
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../../util/prisma.js', () => ({
  default: {
    booking: { findUnique: jest.fn(), updateMany: jest.fn() },
    payment: { findUnique: jest.fn(), updateMany: jest.fn() },
  },
}));
jest.unstable_mockModule('../../../queues/notificationQueue.js', () => ({
  addNotificationJob: jest.fn(),
}));
jest.unstable_mockModule('../../../services/refundPolicy.js', () => ({
  executeCancellationRefund: jest.fn(),
}));

const prisma = (await import('../../../util/prisma.js')).default;
const { executeCancellationRefund } = await import('../../../services/refundPolicy.js');
const { cancelNoShowBooking } = await import('../../../controllers/Admin/bookingController.js');

const BOOKING_ID = 801;
const booking = (o = {}) => ({ id: BOOKING_ID, userId: 5, status: 'in_progress', notes: null, ...o });
const payment = (o = {}) => ({ id: 901, bookingId: BOOKING_ID, status: 'success', vendorPayoutStatus: 'pending', ...o });
const mockReq = (body = { reason: 'Vendor never arrived' }, params = { id: String(BOOKING_ID) }) => ({ body, params, user: { id: 1 } });
const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  prisma.booking.findUnique.mockResolvedValue(booking());
  prisma.booking.updateMany.mockResolvedValue({ count: 1 });
  prisma.payment.findUnique.mockResolvedValue(payment());
  prisma.payment.updateMany.mockResolvedValue({ count: 1 });
  executeCancellationRefund.mockResolvedValue({ refunded: true, amount: 500, code: 'REFUND_ISSUED' });
});

describe('cancelNoShowBooking', () => {
  test('cancels an in_progress booking with a guarded write and voids a pending payout', async () => {
    const res = mockRes();
    await cancelNoShowBooking(mockReq(), res);

    expect(prisma.booking.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: BOOKING_ID, status: 'in_progress' },
      data: expect.objectContaining({ status: 'cancelled', notes: expect.stringContaining('[Admin no-show cancel by 1]') }),
    }));
    expect(prisma.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 901, vendorPayoutStatus: 'pending' },
      data: { vendorPayoutStatus: 'not_applicable' },
    });
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ payout: 'not_applicable' }));
  });

  test('issues a FULL refund through the existing refund path', async () => {
    await cancelNoShowBooking(mockReq(), mockRes());
    expect(executeCancellationRefund).toHaveBeenCalledWith(expect.objectContaining({
      booking: expect.objectContaining({ id: BOOKING_ID }),
      payment: expect.objectContaining({ id: 901 }),
      forceFullRefund: true,
    }));
  });

  test.each(['paid', 'settled'])('leaves a %s payout untouched', async (st) => {
    prisma.payment.findUnique.mockResolvedValue(payment({ vendorPayoutStatus: st }));
    prisma.payment.updateMany.mockResolvedValue({ count: 0 });
    const res = mockRes();
    await cancelNoShowBooking(mockReq(), res);

    // Only the pending-guarded write is attempted; it matches nothing.
    expect(prisma.payment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 901, vendorPayoutStatus: 'pending' },
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ payout: 'untouched_already_paid' }));
    expect(executeCancellationRefund).toHaveBeenCalled();
  });

  test('409s when the booking is not in_progress', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking({ status: 'confirmed' }));
    const res = mockRes();
    await cancelNoShowBooking(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
    expect(executeCancellationRefund).not.toHaveBeenCalled();
  });

  test('409s while the vendor payout is processing (no double payout)', async () => {
    prisma.payment.findUnique.mockResolvedValue(payment({ vendorPayoutStatus: 'processing' }));
    const res = mockRes();
    await cancelNoShowBooking(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(executeCancellationRefund).not.toHaveBeenCalled();
  });

  test('409s when the guarded write loses a race', async () => {
    prisma.booking.updateMany.mockResolvedValue({ count: 0 });
    const res = mockRes();
    await cancelNoShowBooking(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(executeCancellationRefund).not.toHaveBeenCalled();
  });

  test('404s for a missing booking and 400s for a bad id', async () => {
    prisma.booking.findUnique.mockResolvedValue(null);
    const res = mockRes();
    await cancelNoShowBooking(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);

    const res2 = mockRes();
    await cancelNoShowBooking(mockReq({}, { id: 'abc' }), res2);
    expect(res2.status).toHaveBeenCalledWith(400);
  });

  test('no payment: cancels without payout write and reports NO_PAYMENT', async () => {
    prisma.payment.findUnique.mockResolvedValue(null);
    executeCancellationRefund.mockResolvedValue({ refunded: false, code: 'NO_PAYMENT' });
    const res = mockRes();
    await cancelNoShowBooking(mockReq(), res);
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ payout: 'none', refund: expect.objectContaining({ code: 'NO_PAYMENT' }) }));
  });
});

describe('cancel-no-show route guard', () => {
  test('is mounted behind authAdmin + authorizeAdmin + authorizeSuperAdmin', async () => {
    const { default: router } = await import('../../../routes/Admin/bookings.js');
    const { authAdmin, authorizeAdmin, authorizeSuperAdmin } = await import('../../../middleware/authAdminMiddleware.js');
    const layer = router.stack.find((l) => l.route?.path === '/bookings/:id/cancel-no-show');
    expect(layer).toBeDefined();
    expect(layer.route.methods.post).toBe(true);
    const handles = layer.route.stack.map((s) => s.handle);
    expect(handles.slice(0, 3)).toEqual([authAdmin, authorizeAdmin, authorizeSuperAdmin]);
    expect(handles[3]).toBe(cancelNoShowBooking);
  });
});
