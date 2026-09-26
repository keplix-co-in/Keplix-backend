import { jest } from '@jest/globals';

/**
 * POST/DELETE /accounts/auth/web-push — saving a browser's push subscription.
 *
 * The server later POSTs to the stored endpoint, so the important guarantees are
 * about what may be stored (real push-service hosts only, bounded keys, bounded
 * rows per user) and who may remove it (only its owner).
 */

process.env.JWT_SECRET = 'test_access_secret';

const mockPrisma = {
  webPushSubscription: {
    findMany: jest.fn(),
    deleteMany: jest.fn(),
    upsert: jest.fn(),
  },
};
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../util/firebase.js', () => ({
  default: { auth: () => ({ verifyIdToken: jest.fn() }) },
  messaging: null,
}));
jest.unstable_mockModule('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: jest.fn() })),
}));

const { registerWebPush, unregisterWebPush } = await import('../../controllers/authController.js');

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';
const KEYS = { p256dh: 'BPublicKeyValue', auth: 'authSecretValue' };

const mockReq = (body, userId = 7, userAgent = 'Chrome/130') => ({
  body,
  user: { id: userId },
  get: (h) => (h.toLowerCase() === 'user-agent' ? userAgent : undefined),
});
const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockPrisma.webPushSubscription.findMany.mockResolvedValue([]);
  mockPrisma.webPushSubscription.upsert.mockResolvedValue({});
  mockPrisma.webPushSubscription.deleteMany.mockResolvedValue({ count: 1 });
});

describe('registerWebPush', () => {
  test('saves a valid subscription for the signed-in user', async () => {
    const res = mockRes();
    await registerWebPush(mockReq({ endpoint: ENDPOINT, keys: KEYS }), res);

    expect(mockPrisma.webPushSubscription.upsert).toHaveBeenCalledWith({
      where: { endpoint: ENDPOINT },
      update: { userId: 7, p256dh: KEYS.p256dh, auth: KEYS.auth, userAgent: 'Chrome/130' },
      create: { userId: 7, endpoint: ENDPOINT, p256dh: KEYS.p256dh, auth: KEYS.auth, userAgent: 'Chrome/130' },
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  test('re-attaches an existing browser to whoever is signed in now (upsert by endpoint)', async () => {
    await registerWebPush(mockReq({ endpoint: ENDPOINT, keys: KEYS }, 99), mockRes());
    expect(mockPrisma.webPushSubscription.upsert.mock.calls[0][0].update.userId).toBe(99);
  });

  test.each([
    ['an internal address', 'https://169.254.169.254/latest'],
    ['plain http', 'http://fcm.googleapis.com/fcm/send/abc'],
    ['a look-alike host', 'https://fcm.googleapis.com.evil.com/x'],
    ['a missing endpoint', undefined],
  ])('rejects %s with 400 and stores nothing', async (_label, endpoint) => {
    const res = mockRes();
    await registerWebPush(mockReq({ endpoint, keys: KEYS }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.webPushSubscription.upsert).not.toHaveBeenCalled();
  });

  test.each([
    ['no keys', undefined],
    ['empty keys', { p256dh: '', auth: '' }],
    ['non-string keys', { p256dh: 1, auth: {} }],
    ['oversized keys', { p256dh: 'x'.repeat(300), auth: 'a' }],
  ])('rejects %s with 400', async (_label, keys) => {
    const res = mockRes();
    await registerWebPush(mockReq({ endpoint: ENDPOINT, keys }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.webPushSubscription.upsert).not.toHaveBeenCalled();
  });

  test('keeps at most 5 browsers per user by dropping the oldest', async () => {
    // Newest first, as the query orders them; 5 others already exist.
    mockPrisma.webPushSubscription.findMany.mockResolvedValue(
      [{ id: 50 }, { id: 40 }, { id: 30 }, { id: 20 }, { id: 10 }]
    );

    await registerWebPush(mockReq({ endpoint: ENDPOINT, keys: KEYS }), mockRes());

    // 5 others + the new one = 6, one over the cap, so the single oldest (id 10) goes.
    expect(mockPrisma.webPushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [10] } },
    });
  });

  test('does not prune when under the cap', async () => {
    mockPrisma.webPushSubscription.findMany.mockResolvedValue([{ id: 2 }, { id: 1 }]);
    await registerWebPush(mockReq({ endpoint: ENDPOINT, keys: KEYS }), mockRes());
    expect(mockPrisma.webPushSubscription.deleteMany).not.toHaveBeenCalled();
  });

  test('answers 500 without leaking details when the database fails', async () => {
    mockPrisma.webPushSubscription.upsert.mockRejectedValue(new Error('secret db detail'));
    const res = mockRes();
    await registerWebPush(mockReq({ endpoint: ENDPOINT, keys: KEYS }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('secret db detail');
  });
});

describe('unregisterWebPush', () => {
  test('removes only the caller’s own subscription', async () => {
    const res = mockRes();
    await unregisterWebPush(mockReq({ endpoint: ENDPOINT }, 7), res);

    expect(mockPrisma.webPushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { endpoint: ENDPOINT, userId: 7 },
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  test('requires an endpoint', async () => {
    const res = mockRes();
    await unregisterWebPush(mockReq({}), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.webPushSubscription.deleteMany).not.toHaveBeenCalled();
  });
});
