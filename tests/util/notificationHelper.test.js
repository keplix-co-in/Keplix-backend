import { jest } from '@jest/globals';

/**
 * Tests for util/notificationHelper.js.
 *
 * The helper's signature is positional -- (userId, title, message, metadata) --
 * but four call sites in util/bookingStatusManager.js passed a single object
 * instead. Those calls wrote `userId = {…}` and `title = undefined`, Prisma
 * rejected the row, and the catch swallowed the error, so "Booking Request
 * Declined", "Booking Request Expired", "Service Started" and "Service Time
 * Arrived" were never delivered to anyone and nothing in the logs said so.
 *
 * The helper now accepts both shapes. These tests pin that down, plus the two
 * things that made the original bug invisible: a row with no title must never
 * be written (both apps call `title.includes(...)`, which throws on null and
 * takes down the whole notification list), and a bad call must be logged.
 */

const mockPrisma = {
  notification: { create: jest.fn() },
  user: { findUnique: jest.fn() },
};
const mockLogger = {
  debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
};

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../util/logger.js', () => ({ default: mockLogger }));

const { createNotification, sendPushNotification } = await import('../../util/notificationHelper.js');

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.notification.create.mockResolvedValue({ id: 1 });
  // No push token: keeps these tests about the DB row, not Expo.
  mockPrisma.user.findUnique.mockResolvedValue({ pushToken: null });
});

const createdRow = () => mockPrisma.notification.create.mock.calls[0][0].data;

describe('createNotification — positional form', () => {
  test('writes the row', async () => {
    await createNotification(7, 'Booking accepted', 'Your booking is confirmed.');
    expect(createdRow()).toMatchObject({
      userId: 7,
      title: 'Booking accepted',
      message: 'Your booking is confirmed.',
    });
  });

  test('persists type and data from metadata', async () => {
    await createNotification(7, 'Payment received', 'Paid.', {
      type: 'PAYMENT_RECEIVED',
      data: { bookingId: 42 },
    });
    const row = createdRow();
    expect(row.type).toBe('PAYMENT_RECEIVED');
    expect(row.data).toEqual({ bookingId: 42 });
  });
});

describe('createNotification — object form (the four broken call sites)', () => {
  test('a single object argument is understood', async () => {
    await createNotification({
      userId: 12,
      title: 'Service started',
      message: 'Your service has started.',
      type: 'SERVICE_STARTED',
      data: { bookingId: 99 },
    });

    expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
    expect(createdRow()).toMatchObject({
      userId: 12,
      title: 'Service started',
      message: 'Your service has started.',
      type: 'SERVICE_STARTED',
      data: { bookingId: 99 },
    });
  });

  test('both call shapes produce an equivalent row', async () => {
    await createNotification(5, 'Same title', 'Same body', { type: 'T' });
    const positional = createdRow();

    jest.clearAllMocks();
    mockPrisma.notification.create.mockResolvedValue({ id: 2 });
    mockPrisma.user.findUnique.mockResolvedValue({ pushToken: null });

    await createNotification({ userId: 5, title: 'Same title', message: 'Same body', type: 'T' });
    const object = createdRow();

    expect(object.userId).toBe(positional.userId);
    expect(object.title).toBe(positional.title);
    expect(object.message).toBe(positional.message);
    expect(object.type).toBe(positional.type);
  });

  test('accepts `body` as an alias for `message`', async () => {
    await createNotification({ userId: 3, title: 'T', body: 'B' });
    expect(createdRow().message).toBe('B');
  });
});

describe('createNotification — invalid input', () => {
  test('never writes a row with no title, and logs it', async () => {
    const result = await createNotification({ userId: 4 });
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalled();
    expect(result).toBeNull();
  });

  test('never writes a row with no userId', async () => {
    await createNotification(null, 'Title', 'Body');
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalled();
  });

  test('a DB failure is logged but does not throw — a notification must not roll back a booking', async () => {
    mockPrisma.notification.create.mockRejectedValue(new Error('db down'));
    await expect(createNotification(1, 'T', 'M')).resolves.toBeNull();
    expect(mockLogger.error).toHaveBeenCalled();
  });

  test('a missing message becomes an empty string, never the text "undefined"', async () => {
    await createNotification({ userId: 1, title: 'T' });
    expect(createdRow().message).toBe('');
  });
});

describe('sendPushNotification — token validation', () => {
  test('refuses a non-Expo token (the FCM token the dispute flow used to pass)', async () => {
    const result = await sendPushNotification('some-fcm-token-value', 'T', 'B');
    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  test('refuses a missing token', async () => {
    expect(await sendPushNotification(null, 'T', 'B')).toBeNull();
  });
});
