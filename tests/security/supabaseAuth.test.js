/**
 * 2026-11 Supabase Auth migration: the backend accepts ONLY Supabase access
 * tokens (replaces the old JWT tests: authMiddleware, jwtTypeConfusion,
 * socketAuthAndBlacklistCap). Tokens here are really signed with a throwaway
 * ES256 key and verified through jose, so issuer/audience/expiry checks are
 * exercised for real, not mocked.
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
jest.unstable_mockModule('socket.io', () => ({
  Server: jest.fn().mockImplementation(() => ({ use: (fn) => { middleware = fn; }, on: () => {} })),
}));

const supa = await import('../../util/supabaseAuth.js');
const { protect, blacklistToken, MAX_BLACKLIST_TTL_SECONDS } = await import('../../middleware/authMiddleware.js');
const { authAdmin } = await import('../../middleware/authAdminMiddleware.js');
const { syncSupabaseUser, legacyAuthRetired, getAdminMe } = await import('../../controllers/supabaseAuthController.js');
const { initSocket } = await import('../../socket.js');
initSocket({});

const { publicKey, privateKey } = await generateKeyPair('ES256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' };
supa._setKeyResolverForTests(createLocalJWKSet({ keys: [jwk] }));
const other = await generateKeyPair('ES256');

const sign = (claims = {}, { iss = ISS, aud = 'authenticated', exp = '1h', key = privateKey } = {}) =>
  new SignJWT({ email: 'A@x.com', role: 'authenticated', ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setSubject(SUB).setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp)
    .sign(key);

const res = () => { const r = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); return r; };
const req = (token, extra = {}) => ({ headers: token ? { authorization: `Bearer ${token}` } : {}, ...extra });
const USER = { id: 1, email: 'a@x.com', role: 'user', is_active: true, is_verified: true, userProfile: { name: 'A', phone: '' }, vendorProfile: null };

let fetchMock;
beforeEach(() => {
  jest.clearAllMocks();
  for (const d of [prismaMock.user, prismaMock.admin]) for (const f of Object.values(d)) f.mockReset();
  fetchMock = jest.fn();
  global.fetch = fetchMock;
});

describe('verifySupabaseToken', () => {
  test('accepts a valid token and lowercases email', async () => {
    await expect(supa.verifySupabaseToken(await sign())).resolves.toMatchObject({ sub: SUB, email: 'a@x.com' });
  });
  test.each([
    ['wrong issuer', () => sign({}, { iss: 'https://evil.supabase.co/auth/v1' })],
    ['wrong audience', () => sign({}, { aud: 'anon' })],
    ['expired', () => sign({}, { exp: Math.floor(Date.now() / 1000) - 60 })],
    ['foreign key', () => sign({}, { key: other.privateKey })],
    ['anonymous session', () => sign({ is_anonymous: true })],
    ['non-user role', () => sign({ role: 'service_role' })],
  ])('rejects %s', async (_n, make) => {
    await expect(supa.verifySupabaseToken(await make())).rejects.toThrow();
  });
  test('rejects an old HS256 backend token', async () => {
    const old = await new SignJWT({ id: 1, type: 'access' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode('your-secret-key'));
    await expect(supa.verifySupabaseToken(old)).rejects.toThrow();
  });
});

describe('protect', () => {
  test('401 without a token', async () => {
    const r = res(); const next = jest.fn();
    await protect(req(), r, next);
    expect(r.status).toHaveBeenCalledWith(401); expect(next).not.toHaveBeenCalled();
  });
  test('401 on a bad token', async () => {
    const r = res(); const next = jest.fn();
    await protect(req('garbage'), r, next);
    expect(r.status).toHaveBeenCalledWith(401); expect(next).not.toHaveBeenCalled();
  });
  test('linked user passes and is attached', async () => {
    prismaMock.user.findFirst.mockResolvedValueOnce(USER);
    const r = req(await sign()); const next = jest.fn();
    await protect(r, res(), next);
    expect(next).toHaveBeenCalled(); expect(r.user.id).toBe(1); expect(r.supabaseClaims.sub).toBe(SUB);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test('inactive user gets 403', async () => {
    prismaMock.user.findFirst.mockResolvedValueOnce({ ...USER, is_active: false });
    const r = res(); const next = jest.fn();
    await protect(req(await sign()), r, next);
    expect(r.status).toHaveBeenCalledWith(403); expect(next).not.toHaveBeenCalled();
  });
  test('unknown user gets 401', async () => {
    prismaMock.user.findFirst.mockResolvedValue(null);
    const r = res();
    await protect(req(await sign()), r, jest.fn());
    expect(r.status).toHaveBeenCalledWith(401);
  });
});

describe('first-login email linking', () => {
  const setupByEmail = (current = { supabaseId: null }) => {
    prismaMock.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(USER);
    prismaMock.user.findUnique.mockResolvedValueOnce(current);
  };
  test('links when Supabase confirms the email', async () => {
    setupByEmail();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ email: 'a@x.com', email_confirmed_at: '2026-01-01' }) });
    const next = jest.fn();
    await protect(req(await sign()), res(), next);
    expect(next).toHaveBeenCalled();
    expect(prismaMock.user.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { supabaseId: SUB } });
    expect(fetchMock.mock.calls[0][0]).toBe(`${ISS}/admin/users/${SUB}`);
  });
  test('does not link an unconfirmed email', async () => {
    setupByEmail();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ email: 'a@x.com', email_confirmed_at: null }) });
    const r = res();
    await protect(req(await sign()), r, jest.fn());
    expect(r.status).toHaveBeenCalledWith(401); expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
  test('never re-links a row owned by another Supabase user', async () => {
    setupByEmail({ supabaseId: '22222222-2222-2222-2222-222222222222' });
    const r = res();
    await protect(req(await sign()), r, jest.fn());
    expect(r.status).toHaveBeenCalledWith(401);
    expect(fetchMock).not.toHaveBeenCalled(); expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});

describe('authAdmin', () => {
  test('active admin passes with {id, role}', async () => {
    prismaMock.admin.findFirst.mockResolvedValueOnce({ id: 1, role: 'super_admin', status: 'ACTIVE' });
    const r = req(await sign()); const next = jest.fn();
    await authAdmin(r, res(), next);
    expect(next).toHaveBeenCalled(); expect(r.user).toEqual({ id: 1, role: 'super_admin' });
  });
  test('non-active admin gets 403', async () => {
    prismaMock.admin.findFirst.mockResolvedValueOnce({ id: 1, role: 'admin', status: 'SUSPENDED' });
    const r = res();
    await authAdmin(req(await sign()), r, jest.fn());
    expect(r.status).toHaveBeenCalledWith(403);
  });
  test('a customer with no Admin row is refused (no cross-table confusion)', async () => {
    prismaMock.admin.findFirst.mockResolvedValue(null);
    const r = res(); const next = jest.fn();
    await authAdmin(req(await sign()), r, next);
    expect(r.status).toHaveBeenCalledWith(401); expect(next).not.toHaveBeenCalled();
    expect(prismaMock.user.findFirst).not.toHaveBeenCalled();
  });
  test('missing token gets 401', async () => {
    const r = res();
    await authAdmin(req(), r, jest.fn());
    expect(r.status).toHaveBeenCalledWith(401);
  });
});

describe('socket handshake', () => {
  const run = (token) => new Promise((resolve) => {
    const socket = { handshake: { auth: { token } } };
    middleware(socket, (err) => resolve({ err, socket }));
  });
  test('accepts a valid Supabase token', async () => {
    prismaMock.user.findFirst.mockResolvedValueOnce({ id: 7, role: 'user', is_active: true });
    const { err, socket } = await run(await sign());
    expect(err).toBeUndefined(); expect(socket.authUser.id).toBe(7);
  });
  test('rejects a forged token', async () => {
    const { err } = await run(await sign({}, { key: other.privateKey }));
    expect(err).toBeInstanceOf(Error);
  });
});

describe('POST /supabase/sync', () => {
  const claims = { sub: SUB, email: 'new@x.com' };
  test('creates a user once, role whitelisted', async () => {
    prismaMock.user.findFirst.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({ id: 5, email: 'new@x.com', role: 'user', is_active: true, userProfile: null, vendorProfile: null });
    prismaMock.user.findUnique.mockResolvedValue({ id: 5, email: 'new@x.com', role: 'user', is_active: true, userProfile: { name: 'Neo' }, vendorProfile: null });
    const r = res();
    await syncSupabaseUser({ supabaseClaims: claims, body: { role: 'admin', name: 'Neo' } }, r);
    expect(prismaMock.user.create.mock.calls[0][0].data).toMatchObject({ role: 'user', supabaseId: SUB });
    // No password is ever stored in Keplix's DB: Supabase Auth holds it.
    expect(prismaMock.user.create.mock.calls[0][0].data).not.toHaveProperty('password');
    expect(prismaMock.userProfile.create).toHaveBeenCalled();
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ isNewUser: true }));
  });
  test('existing linked user is returned, nothing created', async () => {
    prismaMock.user.findFirst.mockResolvedValueOnce(USER);
    const r = res();
    await syncSupabaseUser({ supabaseClaims: claims, body: {} }, r);
    expect(prismaMock.user.create).not.toHaveBeenCalled();
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ isNewUser: false }));
  });
  test('an unlinkable existing email is 409, never duplicated', async () => {
    prismaMock.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(USER).mockResolvedValueOnce({ id: 1 });
    prismaMock.user.findUnique.mockResolvedValueOnce({ supabaseId: '22222222-2222-2222-2222-222222222222' });
    const r = res();
    await syncSupabaseUser({ supabaseClaims: claims, body: {} }, r);
    expect(r.status).toHaveBeenCalledWith(409); expect(prismaMock.user.create).not.toHaveBeenCalled();
  });
  test('400 when the session has no email', async () => {
    const r = res();
    await syncSupabaseUser({ supabaseClaims: { sub: SUB, email: null }, body: {} }, r);
    expect(r.status).toHaveBeenCalledWith(400);
  });
});

describe('GET /admin/auth/me', () => {
  test('returns only id/name/email/role of the signed-in admin', async () => {
    prismaMock.admin.findUnique.mockResolvedValue({ id: 7, name: 'Ops', email: 'o@x.com', role: 'admin' });
    const r = res();
    await getAdminMe({ user: { id: 7, role: 'admin' } }, r);
    expect(prismaMock.admin.findUnique.mock.calls[0][0]).toEqual({ where: { id: 7 }, select: { id: true, name: true, email: true, role: true } });
    expect(r.json).toHaveBeenCalledWith({ user: { id: 7, name: 'Ops', email: 'o@x.com', role: 'admin' } });
  });
  test('401 when the admin row is gone', async () => {
    prismaMock.admin.findUnique.mockResolvedValue(null);
    const r = res();
    await getAdminMe({ user: { id: 7 } }, r);
    expect(r.status).toHaveBeenCalledWith(401);
  });
  test('route is behind authAdmin', async () => {
    const fs = await import('fs');
    const lines = fs.readFileSync(new URL('../../routes/Admin/authAdmin.js', import.meta.url), 'utf8').split(String.fromCharCode(10));
    expect(lines.find((l) => l.includes("'/me'"))).toContain('authAdmin, getAdminMe');
  });
});

describe('legacy routes', () => {
  test('answer 426 APP_UPDATE_REQUIRED', () => {
    const r = res();
    legacyAuthRetired({}, r);
    expect(r.status).toHaveBeenCalledWith(426);
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'APP_UPDATE_REQUIRED' }));
  });
  test('login/refresh/google and admin login are wired to it', async () => {
    const fs = await import('fs');
    const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').split(/\r?\n/);
    const auth = read('../../routes/auth.js');
    for (const route of ['/login', '/token/refresh', '/google', '/register']) {
      expect(auth.find((l) => l.includes(`'${route}'`))).toContain('legacyAuthRetired');
    }
    const admin = read('../../routes/Admin/authAdmin.js');
    expect(admin.find((l) => l.includes("'/login'"))).toContain('legacyAuthRetired');
  });
});

describe('blacklistToken cap (A-007)', () => {
  test('clamps a far-future exp to the max TTL', async () => {
    const now = Math.floor(Date.now() / 1000);
    await blacklistToken('t', now + 10 * 365 * 24 * 3600);
    const { expiresAt } = prismaMock.blacklistedToken.upsert.mock.calls[0][0].create;
    expect(expiresAt.getTime() / 1000).toBeLessThanOrEqual(now + MAX_BLACKLIST_TTL_SECONDS + 2);
  });
  test('ignores a missing exp', async () => {
    await expect(blacklistToken('t', undefined)).resolves.toBeUndefined();
    expect(prismaMock.blacklistedToken.upsert).not.toHaveBeenCalled();
  });
});
