/**
 * Pricing v2 completion gate (docs/PRICING_V2_API.md section 4): a v2 booking
 * (has a BookingQuote) cannot be marked service_completed until a final bill
 * with status issued|paid exists -> 409 BILL_NOT_ISSUED. The same rule is in
 * the guarded write's WHERE, so a bill voided in between still blocks.
 * Legacy bookings are unaffected. Harness follows vendorCompletionTransitions.
 */
import { jest } from '@jest/globals';

const mockPrisma = {
  booking: { findFirst: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
  payment: { updateMany: jest.fn() },
};

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../util/payoutHelper.js', () => ({ initiateVendorPayout: jest.fn() }));
jest.unstable_mockModule('../../util/communication.js', () => ({ sendPushNotification: jest.fn() }));
jest.unstable_mockModule('../../util/notificationHelper.js', () => ({ createNotification: jest.fn() }));
jest.unstable_mockModule('../../services/healthSheetService.js', () => ({
  assertHealthSheetPresent: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.unstable_mockModule('../../util/platformSettings.js', () => ({
  resolvePayoutHoldUntil: jest.fn().mockResolvedValue(null),
}));
jest.unstable_mockModule('../../queues/notificationQueue.js', () => ({
  addNotificationJob: jest.fn(),
  default: jest.fn(),
}));

const { updateBookingStatus } = await import('../../controllers/vendor/bookingController.js');

const VENDOR = 42;
const mockRes = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });
const req = () => ({ user: { id: VENDOR }, params: { id: '100' }, body: { status: 'service_completed' }, files: {}, app: { get: () => null } });
const row = (over) => ({ id: 100, status: 'in_progress', createdAt: new Date(), bookingQuote: null, finalBills: [], ...over });

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.booking.findUnique.mockResolvedValue({ id: 100, userId: 1, status: 'service_completed', service: { id: 7, vendorId: VENDOR, name: 'Brakes' } });
});

describe('v2 completion gate', () => {
  test('v2 booking with no issued bill -> 409 BILL_NOT_ISSUED, nothing written', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue(row({ bookingQuote: { id: 9 } }));
    const res = mockRes();
    await updateBookingStatus(req(), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'BILL_NOT_ISSUED' }));
    expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
  });

  test('v2 booking with a bill -> completes, and the write re-checks the bill in its WHERE', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue(row({ bookingQuote: { id: 9 }, finalBills: [{ id: 3 }] }));
    const res = mockRes();
    await updateBookingStatus(req(), res);
    expect(res.status).not.toHaveBeenCalled();
    const { where, data } = mockPrisma.booking.updateMany.mock.calls[0][0];
    expect(where.finalBills).toEqual({ some: { status: { in: ['issued', 'paid'] } } });
    expect(data.status).toBe('service_completed');
  });

  test('legacy booking completes exactly as before (no bill check in the WHERE)', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue(row());
    const res = mockRes();
    await updateBookingStatus(req(), res);
    expect(res.status).not.toHaveBeenCalled();
    expect(mockPrisma.booking.updateMany.mock.calls[0][0].where).not.toHaveProperty('finalBills');
  });
});
