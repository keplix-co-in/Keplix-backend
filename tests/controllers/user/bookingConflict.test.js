import { jest } from '@jest/globals';

jest.unstable_mockModule('../../../util/prisma.js', () => ({
  default: {
    vehicle: { findUnique: jest.fn() },
    service: { findUnique: jest.fn() },
    booking: { findFirst: jest.fn(), create: jest.fn() },
    bookingVehicle: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.unstable_mockModule('../../../queues/notificationQueue.js', () => ({
  addNotificationJob: jest.fn(),
  default: jest.fn(),
}));

const { createBooking } = await import('../../../controllers/user/bookingController.js');
const prisma = (await import('../../../util/prisma.js')).default;

describe('createBooking slot conflict', () => {
  let req, res, tx;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      user: { id: 1 },
      params: { userId: '1' },
      body: {
        serviceId: 7,
        booking_date: '2026-08-25T00:00:00.000Z',
        booking_time: '2:00 PM',
        notes: 'x',
      },
    };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    tx = {
      booking: { findFirst: jest.fn(), create: jest.fn() },
      bookingVehicle: { create: jest.fn() },
    };
    prisma.$transaction.mockImplementation(async (cb) => cb(tx));
    prisma.service.findUnique.mockResolvedValue({
      id: 7,
      vendorId: 42,
      name: 'Detailing',
      price: 1000,
      segmentPrices: [],
    });
    tx.booking.create.mockImplementation(async ({ data }) => ({
      id: 101,
      ...data,
      service: { id: 7, vendorId: 42, name: 'Detailing' },
      user: { userProfile: { name: 'Ann' } },
    }));
  });

  test('returns 409 when the vendor already has a booking at that date and time', async () => {
    tx.booking.findFirst.mockResolvedValue({ id: 55, booking_time: '14:00' });

    await createBooking(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/already booked|no longer available/i) })
    );
    expect(tx.booking.create).not.toHaveBeenCalled();
  });

  test('the conflict check runs inside the transaction, against the tx client', async () => {
    tx.booking.findFirst.mockResolvedValue(null);

    await createBooking(req, res);

    expect(tx.booking.findFirst).toHaveBeenCalled();
    expect(prisma.booking.findFirst).not.toHaveBeenCalled();
  });

  test('the conflict query is scoped to the vendor, the date and the canonical time', async () => {
    tx.booking.findFirst.mockResolvedValue(null);

    await createBooking(req, res);

    const where = tx.booking.findFirst.mock.calls[0][0].where;
    expect(where.service).toEqual(expect.objectContaining({ vendorId: 42 }));
    expect(where.booking_time).toBeDefined();
    // both canonical and legacy representations must be matched
    expect(JSON.stringify(where)).toContain('14:00');
    expect(JSON.stringify(where)).toContain('2:00 PM');
  });

  test('stores booking_time canonicalised to 24h', async () => {
    tx.booking.findFirst.mockResolvedValue(null);

    await createBooking(req, res);

    expect(tx.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ booking_time: '14:00' }) })
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
