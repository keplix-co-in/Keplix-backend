import { jest } from '@jest/globals';

/**
 * util/webPush.js — browser alerts for the vendor portal.
 *
 * What must hold:
 *  - without VAPID keys nothing is sent and nothing throws (feature is just off);
 *  - a new-request alert goes out urgent, with a short TTL and the tag the portal
 *    de-duplicates on, pointing at that booking;
 *  - a subscription the browser has dropped (404/410) is deleted, other failures
 *    are logged and kept;
 *  - one dead browser never blocks the others, and nothing ever throws into the
 *    booking/payment that triggered it;
 *  - only real push-service hosts are accepted as endpoints (the server POSTs to
 *    them, so anything else would be an SSRF vector).
 */

const mockPrisma = {
  webPushSubscription: { findMany: jest.fn(), deleteMany: jest.fn() },
};
const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const mockWebpush = { setVapidDetails: jest.fn(), sendNotification: jest.fn() };

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../util/logger.js', () => ({ default: mockLogger }));
jest.unstable_mockModule('web-push', () => ({ default: mockWebpush }));

const { sendWebPushToUser, isAllowedPushEndpoint, isWebPushConfigured } = await import(
  '../../util/webPush.js'
);

const SUB = (n) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${n}`,
  p256dh: `p256dh-${n}`,
  auth: `auth-${n}`,
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.VAPID_PUBLIC_KEY = 'pub';
  process.env.VAPID_PRIVATE_KEY = 'priv';
  delete process.env.VAPID_SUBJECT;
  mockPrisma.webPushSubscription.findMany.mockResolvedValue([SUB(1)]);
  mockWebpush.sendNotification.mockResolvedValue({ statusCode: 201 });
});

describe('when VAPID keys are missing', () => {
  test('sends nothing and does not touch the database', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;

    await expect(sendWebPushToUser(7, { title: 'x' })).resolves.toBeUndefined();

    expect(isWebPushConfigured()).toBe(false);
    expect(mockPrisma.webPushSubscription.findMany).not.toHaveBeenCalled();
    expect(mockWebpush.sendNotification).not.toHaveBeenCalled();
  });
});

describe('sendWebPushToUser', () => {
  test('sends an urgent, short-lived, tagged payload for a new booking request', async () => {
    await sendWebPushToUser(7, {
      title: 'New service request',
      message: 'Asha requested Oil change.',
      metadata: { type: 'NEW_BOOKING_ALERT', bookingId: 42 },
    });

    expect(mockWebpush.setVapidDetails).toHaveBeenCalledWith('mailto:info@keplix.co.in', 'pub', 'priv');
    expect(mockWebpush.sendNotification).toHaveBeenCalledTimes(1);

    const [subscription, payload, options] = mockWebpush.sendNotification.mock.calls[0];
    expect(subscription).toEqual({
      endpoint: SUB(1).endpoint,
      keys: { p256dh: 'p256dh-1', auth: 'auth-1' },
    });
    expect(JSON.parse(payload)).toEqual({
      title: 'New service request',
      body: 'Asha requested Oil change.',
      tag: 'kx-NEW_BOOKING_ALERT',
      url: '/bookings/42',
      urgent: true,
    });
    expect(options).toEqual({ TTL: 300, urgency: 'high' });
  });

  test('reads the booking id from nested data and is not urgent for other types', async () => {
    await sendWebPushToUser(7, {
      title: 'Payment received',
      metadata: { type: 'PAYMENT_RECEIVED', data: { bookingId: 9 } },
    });

    const [, payload, options] = mockWebpush.sendNotification.mock.calls[0];
    expect(JSON.parse(payload)).toMatchObject({ url: '/bookings/9', urgent: false, body: '' });
    expect(options).toEqual({ TTL: 3600, urgency: 'normal' });
  });

  test('falls back to the notifications page when there is no booking', async () => {
    await sendWebPushToUser(7, { title: 'Hello', metadata: {} });
    const [, payload] = mockWebpush.sendNotification.mock.calls[0];
    expect(JSON.parse(payload)).toMatchObject({ url: '/notifications', tag: 'kx-NOTIFICATION' });
  });

  test('does nothing when the user has no subscriptions', async () => {
    mockPrisma.webPushSubscription.findMany.mockResolvedValue([]);
    await sendWebPushToUser(7, { title: 'x' });
    expect(mockWebpush.sendNotification).not.toHaveBeenCalled();
  });

  test.each([404, 410])('deletes a subscription the browser dropped (%i)', async (statusCode) => {
    mockWebpush.sendNotification.mockRejectedValue(Object.assign(new Error('gone'), { statusCode }));

    await sendWebPushToUser(7, { title: 'x' });

    expect(mockPrisma.webPushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { endpoint: SUB(1).endpoint },
    });
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  test('keeps the subscription and logs on any other failure', async () => {
    mockWebpush.sendNotification.mockRejectedValue(Object.assign(new Error('boom'), { statusCode: 500 }));

    await expect(sendWebPushToUser(7, { title: 'x' })).resolves.toBeUndefined();

    expect(mockPrisma.webPushSubscription.deleteMany).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('status 500'));
  });

  test('one failing browser does not stop the others', async () => {
    mockPrisma.webPushSubscription.findMany.mockResolvedValue([SUB(1), SUB(2)]);
    mockWebpush.sendNotification
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }))
      .mockResolvedValueOnce({ statusCode: 201 });

    await sendWebPushToUser(7, { title: 'x' });

    expect(mockWebpush.sendNotification).toHaveBeenCalledTimes(2);
    expect(mockPrisma.webPushSubscription.deleteMany).toHaveBeenCalledTimes(1);
  });

  test('never throws when the database itself fails', async () => {
    mockPrisma.webPushSubscription.findMany.mockRejectedValue(new Error('db down'));
    await expect(sendWebPushToUser(7, { title: 'x' })).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalled();
  });
});

describe('isAllowedPushEndpoint', () => {
  test.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ])('accepts %s', (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true);
  });

  test.each([
    'http://fcm.googleapis.com/fcm/send/abc', // not https
    'https://169.254.169.254/latest/meta-data', // cloud metadata
    'https://localhost:8080/push',
    'https://evil.example.com/fcm.googleapis.com',
    'https://fcm.googleapis.com.evil.com/x', // suffix trick
    'https://notfcm.googleapis.com.example/x',
    'not a url',
    '',
    null,
    undefined,
    42,
    `https://fcm.googleapis.com/${'a'.repeat(2100)}`, // too long
  ])('rejects %p', (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });
});
