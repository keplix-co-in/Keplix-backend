/**
 * Security O-002 / O-003 / A-013 / A-010 / SYS-006: HTTP-layer hardening,
 * exercised against the real app.js stack.
 *
 *  - O-002: JSON bodies over 100kb are rejected; rawBody exists only on the
 *    Razorpay webhook route.
 *  - O-003: API responses carry default-src 'none' + frame-ancestors 'none'.
 *  - A-013: /health returns only { status }.
 *  - A-010: *.vercel.app origins are no longer trusted; keplix.co.in and its
 *    subdomains still are; ALLOWED_ORIGINS adds exact origins.
 */
import { jest } from '@jest/globals';

// 'test' behaves like production for CORS (only 'development' relaxes it) and
// avoids the production-only required env vars.
process.env.NODE_ENV = 'test';
process.env.ALLOWED_ORIGINS = 'https://preview-one.example.com, not a url ,https://two.example.com/';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-http-layer';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-http-layer';

// Any prisma call resolves to null; $queryRaw (health) resolves.
const anyModel = new Proxy({}, { get: () => jest.fn().mockResolvedValue(null) });
const prismaMock = new Proxy(
  { $queryRaw: jest.fn().mockResolvedValue([{ 1: 1 }]) },
  { get: (t, k) => (k in t ? t[k] : anyModel) }
);
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: prismaMock }));

let seenRawBody;
jest.unstable_mockModule('../../util/webhookVerification.js', () => ({
  verifyRazorpayWebhook: (req) => { seenRawBody = req.rawBody; return false; },
}));
process.env.RAZORPAY_WEBHOOK_SECRET = 'test-webhook-secret';

const request = (await import('supertest')).default;
const { default: app, JSON_BODY_LIMIT } = await import('../../app.js');
const corsOptions = (await import('../../util/cors.js')).default;
const { parseAllowedOriginsEnv } = await import('../../util/cors.js');

const originAllowed = (origin) =>
  new Promise((resolve) => corsOptions.origin(origin, (err, ok) => resolve(!err && ok)));

describe('A-013 /health', () => {
  test('returns only the status field', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'healthy' });
  });
});

describe('O-003 CSP', () => {
  test('API responses use a deny-all policy', async () => {
    const res = await request(app).get('/health');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
  });
});

describe('O-002 body limits', () => {
  test('limit is 100kb', () => {
    expect(JSON_BODY_LIMIT).toBe('100kb');
  });

  test('a JSON body over 100kb is rejected with 413, not parsed', async () => {
    const big = JSON.stringify({ email: 'a@b.com', password: 'x'.repeat(150 * 1024) });
    const res = await request(app)
      .post('/accounts/auth/login')
      .set('Content-Type', 'application/json')
      .send(big);
    expect(res.status).toBe(413);
  });

  test('rawBody is attached on the webhook route', async () => {
    seenRawBody = undefined;
    await request(app)
      .post('/service_api/payments/razorpay-webhook')
      .set('Content-Type', 'application/json')
      .send({ event: 'payment.captured' });
    expect(Buffer.isBuffer(seenRawBody)).toBe(true);
  });
});

describe('A-010 / SYS-006 CORS', () => {
  test('*.vercel.app is no longer trusted', async () => {
    expect(await originAllowed('https://evil-keplix.vercel.app')).toBe(false);
    expect(await originAllowed('https://keplix.vercel.app')).toBe(false);
  });

  test('production origins still work', async () => {
    for (const o of ['https://keplix.co.in', 'https://admin.keplix.co.in', 'https://partner.keplix.co.in', 'https://www.keplix.co.in']) {
      expect(await originAllowed(o)).toBe(true);
    }
    expect(await originAllowed('https://keplix.co.in.evil.com')).toBe(false);
  });

  test('ALLOWED_ORIGINS adds exact origins only', async () => {
    expect(await originAllowed('https://preview-one.example.com')).toBe(true);
    expect(await originAllowed('https://two.example.com')).toBe(true);
    expect(await originAllowed('https://sub.preview-one.example.com')).toBe(false);
    expect(parseAllowedOriginsEnv('https://a.com, *.vercel.app ,')).toEqual(['https://a.com']);
  });
});
