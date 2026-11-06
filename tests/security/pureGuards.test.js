// Security fixes 2026-11: pure helpers (A-026, A-023 hold, A-025, A-014, A-015).
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: {} }));

const { clampLimit, parsePagination, MAX_PAGE_SIZE } = await import('../../util/parsePagination.js');
const { payoutAccountHoldReason, PAYOUT_ACCOUNT_CHANGE_HOLD_MS } = await import('../../util/payoutRules.js');
const { healthSheetTokenExpired, HEALTH_SHEET_TOKEN_TTL_MS } = await import('../../controllers/public/jobSheetController.js');
const cloud = await import('../../util/cloudinary.js');
// Fake, non-secret test config so the helpers know "our" cloud name.
cloud.default.config({ cloud_name: 'testcloud', api_key: 'test-key', api_secret: 'test-secret' });

describe('A-026 clampLimit / parsePagination', () => {
  test('caps huge limits at 100', () => {
    expect(clampLimit('1000000')).toBe(MAX_PAGE_SIZE);
    expect(MAX_PAGE_SIZE).toBe(100);
  });
  test('falls back to the default on junk, floors at 1', () => {
    expect(clampLimit('abc', 15)).toBe(15);
    expect(clampLimit(undefined)).toBe(20);
    expect(clampLimit('0')).toBe(1);
    expect(clampLimit('-5')).toBe(1);
  });
  test('parsePagination computes skip', () => {
    expect(parsePagination({ page: '3', limit: '10' })).toEqual({ page: 3, limit: 10, skip: 20 });
    expect(parsePagination({ page: 'x' })).toEqual({ page: 1, limit: 20, skip: 0 });
  });
});

describe('A-023 payoutAccountHoldReason', () => {
  const now = new Date('2026-11-06T12:00:00Z');
  test('no change -> no hold', () => expect(payoutAccountHoldReason(null, now)).toBeNull());
  test('changed 1h ago -> held', () => {
    const r = payoutAccountHoldReason(new Date(now - 3600e3), now);
    expect(r).toMatch(/Payout held/);
  });
  test('changed more than 24h ago -> released', () => {
    expect(payoutAccountHoldReason(new Date(now - PAYOUT_ACCOUNT_CHANGE_HOLD_MS - 1), now)).toBeNull();
  });
});

describe('A-025 health sheet link expiry', () => {
  const now = new Date('2026-11-06T00:00:00Z');
  test('explicit future expiry is valid, past is expired', () => {
    expect(healthSheetTokenExpired({ token_expires_at: new Date(+now + 1000) }, now)).toBe(false);
    expect(healthSheetTokenExpired({ token_expires_at: new Date(+now - 1000) }, now)).toBe(true);
  });
  test('legacy rows (null expiry) expire 90 days after createdAt', () => {
    expect(healthSheetTokenExpired({ token_expires_at: null, createdAt: new Date(+now - 10 * 864e5) }, now)).toBe(false);
    expect(healthSheetTokenExpired({ token_expires_at: null, createdAt: new Date(+now - HEALTH_SHEET_TOKEN_TTL_MS - 1) }, now)).toBe(true);
  });
});

describe('A-014 acceptOwnCloudinaryUrl', () => {
  test('keeps our own asset URLs and explicit clears', () => {
    const own = 'https://res.cloudinary.com/testcloud/image/upload/v1/media_uploads/a.jpg';
    expect(cloud.acceptOwnCloudinaryUrl(own)).toBe(own);
    expect(cloud.acceptOwnCloudinaryUrl(null)).toBeNull();
    expect(cloud.acceptOwnCloudinaryUrl('')).toBe('');
  });
  test('drops foreign URLs (treated as "not supplied")', () => {
    expect(cloud.acceptOwnCloudinaryUrl('https://evil.example/x.jpg')).toBeUndefined();
    expect(cloud.acceptOwnCloudinaryUrl('https://res.cloudinary.com/othercloud/image/upload/a.jpg')).toBeUndefined();
  });
});

describe('A-015 signPrivateUrl', () => {
  test('public upload URLs pass through unchanged', () => {
    const pub = 'https://res.cloudinary.com/testcloud/image/upload/v1/media_uploads/a.jpg';
    expect(cloud.signPrivateUrl(pub)).toBe(pub);
    expect(cloud.signPrivateUrl(null)).toBeNull();
  });
  test('authenticated assets become an expiring signed link', () => {
    const priv = 'https://res.cloudinary.com/testcloud/image/authenticated/v1/media_uploads/id_proof_front-1.jpg';
    const signed = cloud.signPrivateUrl(priv);
    expect(signed).not.toBe(priv);
    expect(signed).toMatch(/expires_at=\d+/);
    expect(signed).not.toContain('test-secret');
  });
  test('ID proofs and documents are private upload fields', () => {
    expect(cloud.PRIVATE_UPLOAD_FIELDS.has('id_proof_front')).toBe(true);
    expect(cloud.PRIVATE_UPLOAD_FIELDS.has('file_url')).toBe(true);
  });
});
