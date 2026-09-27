import { Prisma } from '@prisma/client';
import { stripVendorSecrets } from '../../util/publicVendor.js';

/**
 * stripVendorSecrets must remove secrets WITHOUT changing how values serialize.
 *
 * It used to recurse into every object. A Date has no own enumerable keys, so it
 * became `{}`; a Prisma Decimal's own fields are {s, e, d}, so a price became
 * {"s":1,"e":2,"d":[148]}. The customer app got booking_date: {} (new Date({}) is
 * invalid; toISOString() then threw "Date value out of bounds" and blanked the
 * whole app) and showed prices as "₹[object Object]".
 *
 * Everything is compared after JSON round-trip, because that is exactly what the
 * phone receives.
 */

const wire = (value) => JSON.parse(JSON.stringify(value));

describe('stripVendorSecrets keeps non-plain values intact', () => {
  test('a Date still serializes as its ISO string (not {})', () => {
    const out = wire(stripVendorSecrets({ booking_date: new Date('2026-04-16T00:00:00.000Z') }));
    expect(out.booking_date).toBe('2026-04-16T00:00:00.000Z');
  });

  test('a Prisma Decimal price still serializes as a string (not {s,e,d})', () => {
    const out = wire(stripVendorSecrets({ price: new Prisma.Decimal('148.50') }));
    expect(out.price).toBe('148.5');
  });

  test('the same holds when nested inside a booking-shaped object and an array', () => {
    const booking = {
      id: 7,
      booking_date: new Date('2026-08-22T00:00:00.000Z'),
      createdAt: new Date('2026-08-22T03:36:04.911Z'),
      service: { price: new Prisma.Decimal(799), vendor: { vendorProfile: { city: 'Gurugram' } } },
      payment: { amount: new Prisma.Decimal('499.00'), createdAt: new Date('2026-08-22T04:00:00.000Z') },
    };
    const [out] = wire(stripVendorSecrets([booking]));

    expect(out.booking_date).toBe('2026-08-22T00:00:00.000Z');
    expect(out.createdAt).toBe('2026-08-22T03:36:04.911Z');
    expect(out.service.price).toBe('799');
    expect(out.payment.amount).toBe('499');
    expect(out.payment.createdAt).toBe('2026-08-22T04:00:00.000Z');
  });

  test('null, undefined, numbers and strings are unchanged', () => {
    expect(stripVendorSecrets(null)).toBeNull();
    expect(stripVendorSecrets(undefined)).toBeUndefined();
    expect(stripVendorSecrets(5)).toBe(5);
    expect(stripVendorSecrets('x')).toBe('x');
  });
});

describe('stripVendorSecrets still removes secrets', () => {
  test('at every depth of plain objects and arrays', () => {
    const out = stripVendorSecrets({
      user: { id: 1, password: 'hash', pushToken: 't' },
      service: {
        vendor: {
          bank_account_number: '123',
          vendorProfile: { upi_id: 'a@b', ifsc_code: 'X', city: 'Delhi', gst_number: 'G' },
        },
      },
      list: [{ otp: '1', name: 'keep' }],
    });

    expect(out.user).toEqual({ id: 1 });
    expect(out.service.vendor.bank_account_number).toBeUndefined();
    expect(out.service.vendor.vendorProfile).toEqual({ city: 'Delhi' });
    expect(out.list).toEqual([{ name: 'keep' }]);
  });

  test('does not mutate its input', () => {
    const input = { password: 'p', keep: new Date('2026-01-01T00:00:00.000Z') };
    stripVendorSecrets(input);
    expect(input.password).toBe('p');
    expect(input.keep).toBeInstanceOf(Date);
  });
});
