// Review fix: A-026 capped every list at 100, which silently truncated live
// own-history screens (user_keplix BookingList/Profile ask for 200; vendor
// app Earnings asks for 1000, HomePage for 200).
import { jest } from '@jest/globals';

const booking = { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) };
jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    booking,
    service: { findMany: jest.fn().mockResolvedValue([{ id: 1 }]) },
  },
}));
jest.unstable_mockModule('../../queues/notificationQueue.js', () => ({ addNotificationJob: jest.fn() }));

const { getUserBookings } = await import('../../controllers/user/bookingController.js');
const { getVendorBookings } = await import('../../controllers/vendor/bookingController.js');

const res = () => { const r = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r; };
beforeEach(() => booking.findMany.mockClear());

test('user bookings honour limit=200 (cap 200, not 100)', async () => {
  await getUserBookings({ user: { id: 1 }, query: { limit: '200' } }, res());
  expect(booking.findMany.mock.calls[0][0].take).toBe(200);
  await getUserBookings({ user: { id: 1 }, query: { limit: '5000' } }, res());
  expect(booking.findMany.mock.calls[1][0].take).toBe(200);
});

test('vendor bookings honour limit up to 1000 and page 2 skips one full page', async () => {
  await getVendorBookings({ user: { id: 9 }, query: { limit: '1000' } }, res());
  expect(booking.findMany.mock.calls[0][0].take).toBe(1000);
  await getVendorBookings({ user: { id: 9 }, query: { limit: '99999', page: '2' } }, res());
  expect(booking.findMany.mock.calls[1][0]).toMatchObject({ take: 1000, skip: 1000 });
});
