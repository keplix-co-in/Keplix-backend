/**
 * Audit fixes: (2) per-user rate limit on subscription order/verify,
 * (3) getVendorSlots visibility gate, (4) trial row on admin approve.
 */
import { jest } from '@jest/globals';
import express from 'express';
import http from 'http';

const DAY = 24 * 60 * 60 * 1000;
const sub = { current: null };
const mockPrisma = {
  vendorProfile: { findUnique: jest.fn(), update: jest.fn() },
  vendorSubscription: { findUnique: jest.fn(async () => sub.current), create: jest.fn(async ({ data }) => data) },
  booking: { findMany: jest.fn().mockResolvedValue([]) },
  document: { findMany: jest.fn() },
};
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../util/logger.js', () => ({ default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../../queues/notificationQueue.js', () => ({ addNotificationJob: jest.fn(), default: jest.fn() }));

const { getVendorSlots } = await import('../../controllers/user/bookingController.js');
const { setVendorStatus } = await import('../../controllers/Admin/vendorController.js');
const { subscriptionPaymentLimiter } = await import('../../middleware/rateLimitMiddleware.js');

const makeRes = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });
const PROFILE = { operating_hours: '10:00 AM - 8:00 PM', breaks: null, holidays: null, status: 'approved' };

describe('getVendorSlots visibility', () => {
  const call = async () => {
    const res = makeRes();
    await getVendorSlots({ params: { vendorId: '42' }, query: { date: '2026-08-25' }, user: { id: 1 } }, res);
    return res;
  };
  beforeEach(() => { sub.current = null; mockPrisma.vendorProfile.findUnique.mockResolvedValue(PROFILE); });

  test('403 GARAGE_UNAVAILABLE when subscription is past grace', async () => {
    sub.current = { ends_at: new Date(Date.now() - 30 * DAY), plan_code: 'x', period: 'trial', starts_at: new Date() };
    const res = await call();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].code).toBe('GARAGE_UNAVAILABLE');
  });
  test('403 when vendor is not approved', async () => {
    mockPrisma.vendorProfile.findUnique.mockResolvedValue({ ...PROFILE, status: 'pending' });
    expect((await call()).status).toHaveBeenCalledWith(403);
  });
  test('visible vendor still gets slots', async () => {
    sub.current = { ends_at: new Date(Date.now() + 30 * DAY), plan_code: 'x', period: 'trial', starts_at: new Date() };
    expect((await call()).status).not.toHaveBeenCalledWith(403);
  });
});

describe('admin approve creates the trial row', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sub.current = null;
    // Complete profile + PAN so the onboarding approval gate passes.
    mockPrisma.vendorProfile.findUnique.mockResolvedValue({ id: 1, status: 'pending', business_name: 'G', owner_name: 'O', phone: '9', address: 'a', city: 'c', pincode: '1', latitude: 1, longitude: 2, operating_hours: '9-5', upi_id: 'a@b' });
    mockPrisma.document.findMany.mockResolvedValue([{ document_type: 'pan_card' }]);
    mockPrisma.vendorProfile.update.mockImplementation(async ({ data }) => ({ userId: 5, status: data.status, business_name: 'G' }));
  });
  const run = async (status) => { const res = makeRes(); await setVendorStatus({ params: { id: '5' }, body: { status }, user: { id: 1 } }, res); return res; };

  test('approved -> trial VendorSubscription created for the vendor', async () => {
    await run('approved');
    expect(mockPrisma.vendorSubscription.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ vendorId: 5, period: 'trial' }) }));
  });
  test('other statuses create nothing', async () => {
    await run('suspended');
    expect(mockPrisma.vendorSubscription.create).not.toHaveBeenCalled();
  });
  test('trial-row failure does not fail the approval', async () => {
    mockPrisma.vendorSubscription.findUnique.mockRejectedValueOnce(new Error('db'));
    const res = await run('approved');
    expect(res.status).not.toHaveBeenCalledWith(500);
  });
});

describe('subscriptionPaymentLimiter', () => {
  test('11th request in an hour for the same user is 429; another user is unaffected', async () => {
    const app = express();
    app.use((req, _res, next) => { req.user = { id: Number(req.headers['x-uid']) }; next(); });
    app.post('/o', subscriptionPaymentLimiter, (_q, r) => r.json({ ok: true }));
    const server = http.createServer(app).listen(0);
    const port = server.address().port;
    const hit = (uid) => new Promise((resolve) => {
      const r = http.request({ port, method: 'POST', path: '/o', headers: { 'x-uid': uid } }, (res) => { res.resume(); resolve(res.statusCode); });
      r.end();
    });
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push(await hit(1));
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
    expect(await hit(2)).toBe(200);
    await new Promise((r) => server.close(r));
  });
});

test('subscription /order and /verify routes mount the limiter', async () => {
  const { readFileSync } = await import('fs');
  const src = readFileSync(new URL('../../routes/vendor/subscriptions.js', import.meta.url), 'utf8');
  expect(src.match(/subscriptionPaymentLimiter, validateRequest/g)).toHaveLength(2);
});
