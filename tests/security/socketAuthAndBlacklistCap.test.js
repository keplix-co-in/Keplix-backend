/**
 * Security A-012: socket handshake honours the logout blacklist and
 * passwordChangedAt, like HTTP `protect`.
 * Security A-007: blacklist rows never outlive the longest token TTL.
 * Security SYS-002: every socket joins its server-managed session room.
 */
import { jest } from '@jest/globals';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-socket-auth';

const prismaMock = {
  user: { findUnique: jest.fn() },
  blacklistedToken: { findUnique: jest.fn(), upsert: jest.fn() },
  conversation: { findUnique: jest.fn() },
};
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: prismaMock }));

let middleware;
let connectionHandler;
jest.unstable_mockModule('socket.io', () => ({
  Server: jest.fn().mockImplementation(() => ({
    use: (fn) => { middleware = fn; },
    on: (evt, fn) => { if (evt === 'connection') connectionHandler = fn; },
  })),
}));

const jwt = (await import('jsonwebtoken')).default;
const { initSocket } = await import('../../socket.js');
const { blacklistToken, MAX_BLACKLIST_TTL_SECONDS } = await import('../../middleware/authMiddleware.js');
initSocket({});

const run = (token) => new Promise((resolve) => {
  const socket = { handshake: { auth: { token } } };
  middleware(socket, (err) => resolve({ err, socket }));
});

beforeEach(() => jest.clearAllMocks());

describe('socket handshake (A-012)', () => {
  const tok = () => jwt.sign({ id: 7, type: 'access' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  test('accepts a valid, non-revoked token', async () => {
    prismaMock.blacklistedToken.findUnique.mockResolvedValue(null);
    prismaMock.user.findUnique.mockResolvedValue({ id: 7, role: 'user', is_active: true, passwordChangedAt: null });
    const { err, socket } = await run(tok());
    expect(err).toBeUndefined();
    expect(socket.authUser.id).toBe(7);
  });

  test('rejects a blacklisted (logged-out) token', async () => {
    prismaMock.blacklistedToken.findUnique.mockResolvedValue({ id: 1 });
    const { err } = await run(tok());
    expect(err).toBeInstanceOf(Error);
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  test('rejects a token issued before the last password change', async () => {
    prismaMock.blacklistedToken.findUnique.mockResolvedValue(null);
    const t = tok();
    prismaMock.user.findUnique.mockResolvedValue({
      id: 7, role: 'user', is_active: true, passwordChangedAt: new Date(Date.now() + 5000),
    });
    const { err } = await run(t);
    expect(err).toBeInstanceOf(Error);
  });

  test('connected sockets join the server-side session room (SYS-002)', () => {
    const socket = { id: 's1', authUser: { id: 7 }, join: jest.fn(), on: jest.fn() };
    connectionHandler(socket);
    expect(socket.join).toHaveBeenCalledWith('session_7');
  });
});

describe('blacklistToken cap (A-007)', () => {
  test('clamps a far-future exp to the max token TTL', async () => {
    const now = Math.floor(Date.now() / 1000);
    await blacklistToken('t', now + 10 * 365 * 24 * 3600);
    const { expiresAt } = prismaMock.blacklistedToken.upsert.mock.calls[0][0].create;
    expect(expiresAt.getTime() / 1000).toBeLessThanOrEqual(now + MAX_BLACKLIST_TTL_SECONDS + 2);
  });

  test('ignores a missing exp instead of throwing', async () => {
    await expect(blacklistToken('t', undefined)).resolves.toBeUndefined();
    expect(prismaMock.blacklistedToken.upsert).not.toHaveBeenCalled();
  });
});
