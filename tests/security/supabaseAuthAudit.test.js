/**
 * Audit 2026-11-07 follow-ups to the Supabase Auth migration
 * (see tests/security/supabaseAuth.test.js for the base suite):
 *  - admins link by supabaseId only (no email takeover)
 *  - privileged User rows are never email-linked
 *  - passwordChangedAt revocation restored for Supabase tokens
 *  - sync role handling / inactive refusal
 *  - socket missing token / inactive user
 *  - every retired legacy route answers 426 over real HTTP (supertest)
 *  - logout drops the sockets opened with that token
 * Tokens are really signed with a throwaway ES256 key, verified via jose.
 */
import { jest } from '@jest/globals';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';

process.env.SUPABASE_URL = 'https://proj.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';
const ISS = 'https://proj.supabase.co/auth/v1';
const SUB = '11111111-1111-1111-1111-111111111111';

const mk = () => ({ findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), create: jest.fn() });
const prismaMock = {
  user: mk(), admin: mk(),
  userProfile: { create: jest.fn() }, vendorProfile: { create: jest.fn() },
  blacklistedToken: { upsert: jest.fn(), findUnique: jest.fn() },
  conversation: { findUnique: jest.fn() },
};
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: prismaMock }));

let middleware;
const disconnectSockets = jest.fn();
const ioIn = jest.fn(() => ({ disconnectSockets }));
jest.unstable_mockModule('socket.io', () => ({
  Server: jest.fn().mockImplementation(() => ({ use: (fn) => { middleware = fn; }, on: () => {}, in: ioIn })),
}));

const supa = await import('../../util/supabaseAuth.js');
const { protect, isIssuedBeforePasswordChange } = await import('../../middleware/authMiddleware.js');
const { authAdmin } = await import('../../middleware/authAdminMiddleware.js');
const { syncSupabaseUser, legacyLogout } = await import('../../controllers/supabaseAuthController.js');
const { initSocket } = await import('../../socket.js');
const { tokenRoom } = await import('../../util/socketSessions.js');
initSocket({});

const { publicKey, privateKey } = await generateKeyPair('ES256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' };
supa._setKeyResolverForTests(createLocalJWKSet({ keys: [jwk] }));

const sign = (claims = {}, { iat } = {}) => {
  const j = new SignJWT({ email: 'boss@x.com', role: 'authenticated', ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setSubject(SUB).setIssuer(ISS).setAudience('authenticated').setExpirationTime('1h');
  if (iat !== undefined) j.setIssuedAt(iat); else j.setIssuedAt();
  return j.sign(privateKey);
};
const res = () => { const r = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); return r; };
const req = (token, extra = {}) => ({ headers: token ? { authorization: `Bearer ${token}` } : {}, ...extra });
const confirmed = { ok: true, json: async () => ({ email: 'boss@x.com', email_confirmed_at: '2026-01-01' }) };

let fetchMock;
beforeEach(() => {
  jest.clearAllMocks();
  for (const d of [prismaMock.user, prismaMock.admin]) for (const f of Object.values(d)) f.mockReset();
  fetchMock = jest.fn();
  global.fetch = fetchMock;
});

describe('fix 1: admin is matched by supabaseId only', () => {
  test('unlinked admin with a matching CONFIRMED email is refused, never linked', async () => {
    // supabaseId lookup misses; an email lookup (if it happened) would hit.
    prismaMock.admin.findFirst.mockImplementation(async ({ where }) =>
      (where.supabaseId ? null : { id: 3, role: 'super_admin', status: 'ACTIVE' }));
    prismaMock.admin.findUnique.mockResolvedValue({ supabaseId: null });
    fetchMock.mockResolvedValue(confirmed);
    const r = res(); const next = jest.fn();
    await authAdmin(req(await sign()), r, next);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(prismaMock.admin.update).not.toHaveBeenCalled();
    expect(prismaMock.admin.findFirst).toHaveBeenCalledTimes(1);
    expect(prismaMock.admin.findFirst.mock.calls[0][0].where).toEqual({ supabaseId: SUB });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test('linked admin passes', async () => {
    prismaMock.admin.findFirst.mockResolvedValueOnce({ id: 3, role: 'admin', status: 'ACTIVE' });
    const r = req(await sign()); const next = jest.fn();
    await authAdmin(r, res(), next);
    expect(next).toHaveBeenCalled();
    expect(r.user).toEqual({ id: 3, role: 'admin' });
  });
});

describe('fix 1: User email-linking', () => {
  const setup = (role) => {
    prismaMock.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 4, role, is_active: true, is_verified: true });
    prismaMock.user.findUnique.mockResolvedValueOnce({ supabaseId: null, role });
    fetchMock.mockResolvedValue(confirmed);
  };
  test('a vendor row links only after the Admin API confirms the email', async () => {
    setup('vendor');
    const next = jest.fn();
    await protect(req(await sign()), res(), next);
    expect(fetchMock).toHaveBeenCalledWith(`${ISS}/admin/users/${SUB}`, expect.anything());
    expect(prismaMock.user.update).toHaveBeenCalledWith({ where: { id: 4 }, data: { supabaseId: SUB } });
    expect(next).toHaveBeenCalled();
  });
  test('a vendor row is NOT linked when the Admin API says unconfirmed', async () => {
    setup('vendor');
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ email: 'boss@x.com', email_confirmed_at: null }) });
    const r = res();
    await protect(req(await sign()), r, jest.fn());
    expect(r.status).toHaveBeenCalledWith(401);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
  test('a privileged (non user/vendor) User row is never email-linked', async () => {
    setup('admin');
    const r = res();
    await protect(req(await sign()), r, jest.fn());
    expect(r.status).toHaveBeenCalledWith(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});

describe('fix 4: passwordChangedAt revocation for Supabase tokens', () => {
  const now = Math.floor(Date.now() / 1000);
  test('token issued before the password change is refused', async () => {
    prismaMock.user.findFirst.mockResolvedValueOnce({ id: 1, role: 'user', is_active: true, is_verified: true, passwordChangedAt: new Date((now - 60) * 1000) });
    const r = res(); const next = jest.fn();
    await protect(req(await sign({}, { iat: now - 600 })), r, next);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(r.json).toHaveBeenCalledWith({ message: 'Not authorized, password changed' });
    expect(next).not.toHaveBeenCalled();
  });
  test('token issued after the change passes', async () => {
    prismaMock.user.findFirst.mockResolvedValueOnce({ id: 1, role: 'user', is_active: true, is_verified: true, passwordChangedAt: new Date((now - 600) * 1000) });
    const next = jest.fn();
    await protect(req(await sign({}, { iat: now - 60 })), res(), next);
    expect(next).toHaveBeenCalled();
  });
  test('same-second token is not refused; null passwordChangedAt never refuses', () => {
    expect(isIssuedBeforePasswordChange(now, new Date(now * 1000 + 900))).toBe(false);
    expect(isIssuedBeforePasswordChange(now, null)).toBe(false);
    expect(isIssuedBeforePasswordChange(now - 1, new Date(now * 1000))).toBe(true);
  });
  test('socket handshake applies the same check (and selects the column)', async () => {
    prismaMock.user.findFirst.mockResolvedValueOnce({ id: 7, role: 'user', is_active: true, passwordChangedAt: new Date((now - 60) * 1000) });
    const err = await new Promise((resolve) => {
      sign({}, { iat: now - 600 }).then((token) => middleware({ handshake: { auth: { token } } }, resolve));
    });
    expect(err).toBeInstanceOf(Error);
    expect(prismaMock.user.findFirst.mock.calls[0][0].select.passwordChangedAt).toBe(true);
  });
});

describe('fix 2: socket handshake', () => {
  const run = (token) => new Promise((resolve) => {
    const socket = { handshake: { auth: token === undefined ? {} : { token } } };
    middleware(socket, (err) => resolve({ err, socket }));
  });
  test('missing token is refused without touching the DB', async () => {
    const { err, socket } = await run(undefined);
    expect(err).toBeInstanceOf(Error);
    expect(socket.authUser).toBeUndefined();
    expect(prismaMock.user.findFirst).not.toHaveBeenCalled();
  });
  test('inactive user is refused', async () => {
    prismaMock.user.findFirst.mockResolvedValueOnce({ id: 7, role: 'user', is_active: false });
    const { err, socket } = await run(await sign());
    expect(err).toBeInstanceOf(Error);
    expect(socket.authUser).toBeUndefined();
  });
});

describe('fix 2: POST /supabase/sync', () => {
  const claims = { sub: SUB, email: 'new@x.com' };
  test("role 'vendor' creates a vendor (with vendorProfile), never an admin", async () => {
    prismaMock.user.findFirst.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({ id: 5, email: 'new@x.com', role: 'vendor', is_active: true, userProfile: null, vendorProfile: null });
    prismaMock.user.findUnique.mockResolvedValue({ id: 5, email: 'new@x.com', role: 'vendor', is_active: true, userProfile: null, vendorProfile: { business_name: 'Garage', status: 'pending' } });
    const r = res();
    await syncSupabaseUser({ supabaseClaims: claims, body: { role: 'vendor', name: 'Garage' } }, r);
    expect(prismaMock.user.create.mock.calls[0][0].data.role).toBe('vendor');
    expect(prismaMock.vendorProfile.create).toHaveBeenCalled();
    expect(prismaMock.admin.create).not.toHaveBeenCalled();
    expect(r.json.mock.calls[0][0].user.role).toBe('vendor');
  });
  test("an existing user's role is NOT changed by the body", async () => {
    prismaMock.user.findFirst.mockResolvedValueOnce({ id: 1, email: 'new@x.com', role: 'user', is_active: true, userProfile: { name: 'A' }, vendorProfile: null });
    const r = res();
    await syncSupabaseUser({ supabaseClaims: claims, body: { role: 'vendor' } }, r);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(prismaMock.user.create).not.toHaveBeenCalled();
    expect(prismaMock.vendorProfile.create).not.toHaveBeenCalled();
    expect(r.json.mock.calls[0][0].user.role).toBe('user');
  });
  test('an inactive existing user is refused (403)', async () => {
    prismaMock.user.findFirst.mockResolvedValueOnce({ id: 1, email: 'new@x.com', role: 'user', is_active: false, userProfile: { name: 'A' }, vendorProfile: null });
    const r = res();
    await syncSupabaseUser({ supabaseClaims: claims, body: {} }, r);
    expect(r.status).toHaveBeenCalledWith(403);
    expect(prismaMock.userProfile.create).not.toHaveBeenCalled();
  });
});

describe('fix 2: legacy routes return 426 over HTTP', () => {
  let app;
  beforeAll(async () => {
    const express = (await import('express')).default;
    const { default: authRouter, logoutRouter } = await import('../../routes/auth.js');
    const { default: adminAuthRouter } = await import('../../routes/Admin/authAdmin.js');
    app = express();
    app.use(express.json());
    app.use('/accounts/auth', authRouter);
    app.use('/accounts/auth', logoutRouter);
    app.use('/admin/auth', adminAuthRouter);
  });
  const request = async () => (await import('supertest')).default;

  test.each([
    '/accounts/auth/login', '/accounts/auth/login/', '/accounts/auth/token/refresh', '/accounts/auth/token/refresh/',
    '/accounts/auth/google', '/accounts/auth/register', '/accounts/auth/signup', '/accounts/auth/signup/',
    '/accounts/auth/send-email-otp', '/accounts/auth/verify-email-otp',
    '/accounts/auth/forgot-password', '/accounts/auth/send-password-reset-otp', '/accounts/auth/reset-password-otp',
    '/accounts/auth/reset-password/abc/def',
    '/admin/auth/login', '/admin/auth/refresh',
  ])('POST %s -> 426 APP_UPDATE_REQUIRED', async (path) => {
    const r = await (await request())(app).post(path).send({ email: 'a@x.com', password: 'x' });
    expect(r.status).toBe(426);
    expect(r.body.code).toBe('APP_UPDATE_REQUIRED');
  });
  test('PUT /accounts/auth/password/change -> 426', async () => {
    const r = await (await request())(app).put('/accounts/auth/password/change').send({});
    expect(r.status).toBe(426);
  });
});

describe('fix 4: logout drops the sockets of that token only', () => {
  test('disconnects the token room', () => {
    const r = res();
    legacyLogout(req('tok-123'), r);
    expect(ioIn).toHaveBeenCalledWith(tokenRoom('tok-123'));
    expect(disconnectSockets).toHaveBeenCalledWith(true);
    expect(r.json).toHaveBeenCalledWith({ message: 'Logged out' });
  });
  test('no token: nothing disconnected, still 200', () => {
    const r = res();
    legacyLogout(req(), r);
    expect(ioIn).not.toHaveBeenCalled();
    expect(r.json).toHaveBeenCalledWith({ message: 'Logged out' });
  });
});
