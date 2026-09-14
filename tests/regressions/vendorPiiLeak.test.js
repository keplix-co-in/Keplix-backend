/**
 * Regression: vendor banking / credential PII must never reach a client.
 *
 * CONFIRMED LIVE against production during the security assessment: the public,
 * unauthenticated GET /service_api/services/:id returned every vendor's
 * bank_account_number, ifsc_code, upi_id, bank_account_holder_name, email, phone,
 * date_of_birth and the User password field, because the controller did
 * `include: { vendor: { include: { vendorProfile: true } } }` and then
 * `res.json({ ...service })`.
 *
 * These tests exercise stripVendorSecrets directly (the shared serializer the
 * fix routes every affected response through). The HTTP-level proof is in the
 * endpoint sweep once a test DB exists; this guards the serializer so a future
 * change cannot silently re-expose the fields.
 */
import { jest } from '@jest/globals';
import { stripVendorSecrets, PUBLIC_VENDOR_PROFILE_FIELDS } from '../../util/publicVendor.js';

const SECRET = [
  'password',
  'bank_account_number',
  'ifsc_code',
  'upi_id',
  'bank_account_holder_name',
  'fcmToken',
  'pushToken',
  'date_of_birth',
  'gst_number',
];

/** A service exactly as Prisma returns it with the broad include that caused the leak. */
const serviceWithVendor = () => ({
  id: 1313,
  name: 'Full Service',
  price: 5000,
  vendor: {
    id: 42,
    email: 'vendor@example.com',
    password: '$2b$10$hashedpasswordvalue',
    role: 'vendor',
    fcmToken: 'fcm-abc',
    vendorProfile: {
      id: 7,
      business_name: 'Royal Auto Care',
      city: 'Delhi',
      bank_account_number: 'AADF2456',
      ifsc_code: 'SDDGY4GUH',
      upi_id: '987654@@glb',
      bank_account_holder_name: 'Adfg',
      date_of_birth: '1990-01-01',
      gst_number: '22AAAAA0000A1Z5',
    },
  },
});

describe('stripVendorSecrets — no banking or credential PII escapes', () => {
  test('removes every secret field at any nesting depth', () => {
    const clean = stripVendorSecrets(serviceWithVendor());
    const flat = JSON.stringify(clean);
    for (const field of SECRET) {
      expect(flat).not.toContain(`"${field}"`);
    }
  });

  test('keeps the fields the app legitimately needs', () => {
    const clean = stripVendorSecrets(serviceWithVendor());
    expect(clean.vendor.vendorProfile.business_name).toBe('Royal Auto Care');
    expect(clean.vendor.vendorProfile.city).toBe('Delhi');
    expect(clean.name).toBe('Full Service');
  });

  test('handles arrays (list endpoints spread ...service per item)', () => {
    const list = [serviceWithVendor(), serviceWithVendor()];
    const clean = stripVendorSecrets(list);
    for (const item of clean) {
      expect(JSON.stringify(item)).not.toContain('bank_account_number');
    }
  });

  test('the public profile allow-list contains no secret field', () => {
    for (const field of SECRET) {
      expect(PUBLIC_VENDOR_PROFILE_FIELDS).not.toContain(field);
    }
  });

  test('null / primitive inputs pass through untouched', () => {
    expect(stripVendorSecrets(null)).toBeNull();
    expect(stripVendorSecrets('x')).toBe('x');
    expect(stripVendorSecrets(5)).toBe(5);
  });
});
