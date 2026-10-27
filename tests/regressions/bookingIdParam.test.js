/**
 * Regression: a non-numeric booking id is a 400, not a 500.
 *
 * Booking handlers did `parseInt(req.params.id)` and passed the result to
 * Prisma. "abc" became NaN, Prisma threw "Argument `id` is missing" and the
 * catch-all answered 500 -- a client mistake reported as a server fault
 * (Postman run, 2026-10-17). parseInt also accepted "12abc" as 12, silently
 * acting on booking 12. util/parseIdParam.js now rejects both, and every
 * handler below answers 400 BEFORE touching the database.
 *
 * Mocked Prisma (any call is recorded and fails the test), no database.
 */
import { jest } from '@jest/globals';

// Every prisma.<model>.<method>() and prisma.$x() lands here.
const prismaCall = jest.fn();
const modelProxy = new Proxy({}, { get: () => prismaCall });
const prismaProxy = new Proxy({}, {
  get: (_target, prop) => (typeof prop === 'string' && prop.startsWith('$') ? prismaCall : modelProxy),
});

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: prismaProxy }));
jest.unstable_mockModule('razorpay', () => ({
  default: jest.fn().mockImplementation(() => ({ payments: { fetch: jest.fn() }, orders: { create: jest.fn() } })),
}));
jest.unstable_mockModule('../../queues/notificationQueue.js', () => ({ addNotificationJob: jest.fn(), default: jest.fn() }));
jest.unstable_mockModule('../../util/notificationHelper.js', () => ({
  createNotification: jest.fn(),
  sendPushNotification: jest.fn(),
}));
// Keeps the vendor controller's import from initialising Firebase Admin.
jest.unstable_mockModule('../../util/communication.js', () => ({ sendPushNotification: jest.fn() }));
jest.unstable_mockModule('../../services/refundPolicy.js', () => ({
  executeCancellationRefund: jest.fn(),
  resolveCancellationRefund: jest.fn(),
}));

const { parseIdParam } = await import('../../util/parseIdParam.js');
const userBookings = await import('../../controllers/user/bookingController.js');
const vendorBookings = await import('../../controllers/vendor/bookingController.js');
const adminBookings = await import('../../controllers/Admin/bookingController.js');
const confirmation = await import('../../controllers/user/serviceConfirmationController.js');
const payments = await import('../../controllers/user/paymentController.js');
const healthSheets = await import('../../controllers/vendor/healthSheetController.js');

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('parseIdParam', () => {
  test.each([
    ['1', 1],
    ['42', 42],
    [' 7 ', 7],
    [7, 7],
    ['2147483647', 2147483647],
  ])('%p -> %p', (input, expected) => {
    expect(parseIdParam(input)).toBe(expected);
  });

  test.each([
    'abc', '12abc', '1.5', '-1', '0', '007', '', ' ', 'undefined', '{{bookingId}}',
    '2147483648', '1e3', 0, -3, 1.5, NaN, null, undefined, {}, [],
  ])('%p -> null', (input) => {
    expect(parseIdParam(input)).toBeNull();
  });
});

// [label, handler, which param carries the id]
const HANDLERS = [
  ['user getPaymentByBooking', userBookings.getPaymentByBooking, 'bookingId'],
  ['user getSingleBooking', userBookings.getSingleBooking, 'id'],
  ['user getCancellationPreview', userBookings.getCancellationPreview, 'id'],
  ['user canProceedToPayment', userBookings.canProceedToPayment, 'id'],
  ['user updateBooking', userBookings.updateBooking, 'id'],
  ['user respondToEarlyStart', userBookings.respondToEarlyStart, 'id'],
  ['user confirmServiceCompletion', confirmation.confirmServiceCompletion, 'id'],
  ['user disputeServiceCompletion', confirmation.disputeServiceCompletion, 'id'],
  ['vendor respondToServiceRequest', vendorBookings.respondToServiceRequest, 'id'],
  ['vendor updateBookingStatus', vendorBookings.updateBookingStatus, 'id'],
  ['vendor requestEarlyStart', vendorBookings.requestEarlyStart, 'id'],
  ['vendor getHealthSheetForBooking', healthSheets.getHealthSheetForBooking, 'id'],
  ['vendor getHealthSheetForWalkInJob', healthSheets.getHealthSheetForWalkInJob, 'id'],
  ['admin forceCompleteBooking', adminBookings.forceCompleteBooking, 'id'],
  ['admin resolveDisputeForCustomer', adminBookings.resolveDisputeForCustomer, 'id'],
];

describe.each(['abc', '12abc', '99999999999'])('id %p', (badId) => {
  test.each(HANDLERS)('%s -> 400 before any database call', async (_label, handler, param) => {
    expect(typeof handler).toBe('function');
    const res = mockRes();
    const req = {
      params: { [param]: badId, userId: '1', vendorId: '1' },
      // Bodies that pass each handler's own body validation, so the id is
      // what gets rejected.
      body: {
        status: 'in_progress',
        vendor_status: 'accepted',
        accept: true,
        reason: 'A reason that is long enough to pass validation',
        requested_time: '10:00',
      },
      query: {},
      user: { id: 1 },
      app: { get: () => undefined },
    };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(prismaCall).not.toHaveBeenCalled();
  });
});

test('createPaymentOrder: a non-numeric bookingId in the body -> 400 before any database call', async () => {
  const res = mockRes();
  await payments.createPaymentOrder({ body: { bookingId: '12abc' }, user: { id: 1 } }, res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(prismaCall).not.toHaveBeenCalled();
});
