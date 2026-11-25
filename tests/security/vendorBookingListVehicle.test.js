import { jest } from '@jest/globals';

const rows = [];
const booking = { findMany: jest.fn(async () => rows) };
jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: { booking, service: { findMany: jest.fn(async () => [{ id: 1 }]) } },
}));
jest.unstable_mockModule('../../queues/notificationQueue.js', () => ({ addNotificationJob: jest.fn() }));

const { getVendorBookings } = await import('../../controllers/vendor/bookingController.js');
const res = () => { const r = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r; };

test('rows carry vehicle + notes, null when absent; one query', async () => {
  rows.length = 0;
  rows.push(
    { id: 1, notes: 'Check brakes', bookingVehicle: { id: 5, segment: 'suv', price_snapshot: 10, vehicle: { registration: 'KA01AB1234', make: 'Tata', model: 'Nexon', fuel_type: 'diesel', segment: 'hatchback' } } },
    { id: 2, notes: '  ', bookingVehicle: null },
  );
  const r = res();
  await getVendorBookings({ user: { id: 9 }, query: {} }, r);
  const out = r.json.mock.calls[0][0];
  expect(out[0].vehicle).toEqual({ make: 'Tata', model: 'Nexon', registration: 'KA01AB1234', segment: 'suv', fuel_type: 'diesel' });
  expect(out[0].notes).toBe('Check brakes');
  expect(out[0].bookingVehicle).toEqual({ id: 5, segment: 'suv', price_snapshot: 10 });
  expect(out[1].vehicle).toBeNull();
  expect(out[1].notes).toBeNull();
  expect(booking.findMany).toHaveBeenCalledTimes(1);
  expect(booking.findMany.mock.calls[0][0].include.bookingVehicle.include.vehicle.select).toBeDefined();
});

test('vehicle deleted: snapshot segment kept, other fields null', async () => {
  rows.length = 0;
  rows.push({ id: 3, notes: null, bookingVehicle: { id: 6, segment: 'sedan', vehicle: null } });
  const r = res();
  await getVendorBookings({ user: { id: 9 }, query: {} }, r);
  expect(r.json.mock.calls[0][0][0].vehicle).toEqual({ make: null, model: null, registration: null, segment: 'sedan', fuel_type: null });
});
