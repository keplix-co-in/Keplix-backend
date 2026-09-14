/**
 * FIX C: config/env.js should fail fast at import time when a required var
 * is missing, naming exactly which one, rather than letting a feature no-op
 * or crash deep inside a request handler when the var is first read.
 */
import { jest } from '@jest/globals';

const REQUIRED_BASE = {
  NODE_ENV: 'development',
  JWT_SECRET: 'test_jwt_secret',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  CLOUDINARY_URL: 'cloudinary://key:secret@cloud',
};

const ORIGINAL_ENV = process.env;

describe('config/env.js', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('passes and exposes values when all required vars are present', async () => {
    Object.assign(process.env, REQUIRED_BASE);
    const { env } = await import('../../config/env.js');
    expect(env.JWT_SECRET).toBe('test_jwt_secret');
    expect(env.DATABASE_URL).toBe(REQUIRED_BASE.DATABASE_URL);
    expect(env.CLOUDINARY_URL).toBe(REQUIRED_BASE.CLOUDINARY_URL);
  });

  test('throws naming the missing var when JWT_SECRET is absent', async () => {
    Object.assign(process.env, REQUIRED_BASE);
    delete process.env.JWT_SECRET;
    await expect(import('../../config/env.js')).rejects.toThrow(/JWT_SECRET/);
  });

  test('throws naming the missing var when DATABASE_URL is absent', async () => {
    Object.assign(process.env, REQUIRED_BASE);
    delete process.env.DATABASE_URL;
    await expect(import('../../config/env.js')).rejects.toThrow(/DATABASE_URL/);
  });

  test('requires Razorpay/RazorpayX vars only in production', async () => {
    Object.assign(process.env, REQUIRED_BASE, { NODE_ENV: 'production' });
    delete process.env.RAZORPAY_KEY_ID;
    await expect(import('../../config/env.js')).rejects.toThrow(/RAZORPAY_KEY_ID/);
  });

  test('does not require Razorpay vars outside production', async () => {
    Object.assign(process.env, REQUIRED_BASE, { NODE_ENV: 'development' });
    delete process.env.RAZORPAY_KEY_ID;
    const { env } = await import('../../config/env.js');
    expect(env.NODE_ENV).toBe('development');
  });

  test('preserves the working BOOKING_PENDING_TIMEOUT_MINUTES default by leaving it optional', async () => {
    Object.assign(process.env, REQUIRED_BASE);
    delete process.env.BOOKING_PENDING_TIMEOUT_MINUTES;
    const { env } = await import('../../config/env.js');
    expect(env.BOOKING_PENDING_TIMEOUT_MINUTES).toBeUndefined();
  });

  // Regression guard for the 2026-09-12 audit finding: both of these were
  // previously unset in production while the app booted fine, and only
  // failed deep inside a request handler (Google login 500ing; password
  // reset links shipping "undefined/..."). Now required in production so
  // boot fails loudly instead, naming exactly which secret was never set.
  test('requires GOOGLE_ALLOWED_AUDIENCES only in production', async () => {
    Object.assign(process.env, REQUIRED_BASE, { NODE_ENV: 'production' });
    delete process.env.GOOGLE_ALLOWED_AUDIENCES;
    await expect(import('../../config/env.js')).rejects.toThrow(/GOOGLE_ALLOWED_AUDIENCES/);
  });

  test('requires FRONTEND_URL only in production', async () => {
    Object.assign(process.env, REQUIRED_BASE, { NODE_ENV: 'production' });
    delete process.env.FRONTEND_URL;
    await expect(import('../../config/env.js')).rejects.toThrow(/FRONTEND_URL/);
  });

  test('does not require GOOGLE_ALLOWED_AUDIENCES or FRONTEND_URL outside production', async () => {
    Object.assign(process.env, REQUIRED_BASE, { NODE_ENV: 'development' });
    delete process.env.GOOGLE_ALLOWED_AUDIENCES;
    delete process.env.FRONTEND_URL;
    const { env } = await import('../../config/env.js');
    expect(env.NODE_ENV).toBe('development');
  });
});
