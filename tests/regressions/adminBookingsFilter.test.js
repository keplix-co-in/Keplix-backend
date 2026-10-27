/**
 * Regression: the admin bookings list's `?type=` filter.
 *
 * getBookings used to recognise only completed/inprogress/confirmed/
 * cancelled/requested; any other value fell through to an empty where-clause,
 * so the panel's "Disputed" or "Refunded" tab silently listed EVERY booking.
 * Every key the panel sends now has an explicit mapping
 * (ADMIN_BOOKING_FILTERS), and an unknown key is a 400, never "all".
 *
 * Also guards the fields the admin card needs: the payment id (the Refund
 * action posts to /admin/finance/payments/:id/refund), payment status, a
 * collapsed refund status, and the four booking fields added by the
 * booking-flow plan (dispute_reason, disputed_at, vendor_reject_reason,
 * service_completed_at).
 *
 * Mocked Prisma, no database.
 */
import { jest } from '@jest/globals';

const mockPrisma = { booking: { findMany: jest.fn() } };
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../queues/notificationQueue.js', () => ({ addNotificationJob: jest.fn() }));

const { ADMIN_BOOKING_FILTERS, getBookings } = await import('../../controllers/Admin/bookingController.js');
const { SETTLED_STATUSES } = await import('../../util/refundView.js');

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

// The keys kepix-admin's bookingFilters (src/data/config.js) sends.
const ADMIN_PANEL_KEYS = [
  'all', 'pending', 'confirmed', 'inprogress', 'service_completed',
  'completed', 'disputed', 'cancelled', 'rejected', 'refunded',
];

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore?.();
});

describe('ADMIN_BOOKING_FILTERS mapping', () => {
  test('maps every key to the expected where-clause', () => {
    expect(ADMIN_BOOKING_FILTERS).toEqual({
      all: {},
      pending: { status: 'pending' },
      requested: { status: 'pending' },
      confirmed: { status: 'confirmed' },
      in_progress: { status: 'in_progress' },
      inprogress: { status: 'in_progress' },
      service_completed: { status: 'service_completed' },
      completed: { status: { in: ['service_completed', 'user_confirmed', 'completed'] } },
      disputed: { status: 'disputed' },
      cancelled: { status: 'cancelled' },
      rejected: { vendor_status: 'rejected' },
      refunded: {
        payment: {
          is: {
            OR: [
              { status: 'refunded' },
              { refunds: { some: { status: { in: SETTLED_STATUSES } } } },
            ],
          },
        },
      },
    });
  });

  test('every key the admin panel sends is mapped, and only "all" is unfiltered', () => {
    for (const key of ADMIN_PANEL_KEYS) {
      expect(ADMIN_BOOKING_FILTERS).toHaveProperty(key);
      if (key !== 'all') {
        expect(Object.keys(ADMIN_BOOKING_FILTERS[key]).length).toBeGreaterThan(0);
      }
    }
  });
});

describe('getBookings', () => {
  test.each(['bogus', 'constructor', '__proto__', 'toString'])(
    "unknown type '%s' -> 400 with the allowed list, and no query runs",
    async (type) => {
      const res = mockRes();

      await getBookings({ query: { type } }, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ allowed: expect.arrayContaining(ADMIN_PANEL_KEYS) }),
      );
      expect(mockPrisma.booking.findMany).not.toHaveBeenCalled();
    },
  );

  test('disputed passes { status: "disputed" } to the query (not an empty filter)', async () => {
    mockPrisma.booking.findMany.mockResolvedValue([]);

    await getBookings({ query: { type: 'disputed' } }, mockRes());

    expect(mockPrisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'disputed' } }),
    );
  });

  test('no type defaults to all', async () => {
    mockPrisma.booking.findMany.mockResolvedValue([]);

    await getBookings({ query: {} }, mockRes());

    expect(mockPrisma.booking.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });

  test('each row exposes payment {id, status, refundStatus}, paymentId and the four booking-flow fields', async () => {
    const disputedAt = new Date('2026-10-19T08:00:00.000Z');
    const completedAt = new Date('2026-10-18T08:00:00.000Z');
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: 1,
        status: 'disputed',
        vendor_status: 'accepted',
        booking_date: new Date('2026-10-18T00:00:00.000Z'),
        booking_time: '2:00 PM',
        createdAt: new Date('2026-10-17T00:00:00.000Z'),
        dispute_reason: 'Brakes still squeal',
        disputed_at: disputedAt,
        vendor_reject_reason: null,
        service_completed_at: completedAt,
        user: { userProfile: { name: 'Asha', phone: '999' } },
        service: { name: 'Brake check', vendor: { vendorProfile: { business_name: 'Garage' } } },
        payment: { id: 900, status: 'success', amount: 1500, platformFee: 150, refunds: [{ status: 'pending' }] },
      },
      {
        id: 2,
        status: 'cancelled',
        vendor_status: 'rejected',
        booking_date: new Date('2026-10-18T00:00:00.000Z'),
        booking_time: '10:00',
        createdAt: new Date('2026-10-17T00:00:00.000Z'),
        dispute_reason: null,
        disputed_at: null,
        vendor_reject_reason: 'Fully booked',
        service_completed_at: null,
        user: { userProfile: { name: 'Ravi', phone: '888' } },
        service: { name: 'Wash', vendor: { vendorProfile: { business_name: 'Garage' } } },
        payment: null,
      },
    ]);
    const res = mockRes();

    await getBookings({ query: { type: 'all' } }, res);

    const { select } = mockPrisma.booking.findMany.mock.calls[0][0];
    for (const field of ['vendor_status', 'dispute_reason', 'disputed_at', 'vendor_reject_reason', 'service_completed_at']) {
      expect(select[field]).toBe(true);
    }
    expect(select.payment.select).toEqual(expect.objectContaining({ id: true, status: true }));

    const [disputed, rejected] = res.json.mock.calls[0][0];
    expect(disputed).toEqual(expect.objectContaining({
      id: 1,
      slot: '2026-10-18 14:00',
      dispute_reason: 'Brakes still squeal',
      disputed_at: disputedAt,
      service_completed_at: completedAt,
      paymentId: 900,
      payment: { id: 900, status: 'success', refundStatus: 'processing' },
    }));
    expect(rejected).toEqual(expect.objectContaining({
      vendor_status: 'rejected',
      vendor_reject_reason: 'Fully booked',
      paymentId: null,
      payment: null,
    }));
  });

  test('refundStatus collapses the refund rows: none -> null, all settled -> completed, all gateway_failed -> failed', async () => {
    const row = (id, refunds) => ({
      id,
      status: 'cancelled',
      booking_date: new Date('2026-10-18T00:00:00.000Z'),
      booking_time: '10:00',
      payment: { id: id * 10, status: 'refunded', amount: 100, platformFee: 10, refunds },
    });
    mockPrisma.booking.findMany.mockResolvedValue([
      row(1, []),
      row(2, [{ status: 'processed' }, { status: 'reconciliation_needed' }]),
      row(3, [{ status: 'gateway_failed' }]),
    ]);
    const res = mockRes();

    await getBookings({ query: { type: 'refunded' } }, res);

    expect(res.json.mock.calls[0][0].map((b) => b.payment.refundStatus)).toEqual([null, 'completed', 'failed']);
  });
});
