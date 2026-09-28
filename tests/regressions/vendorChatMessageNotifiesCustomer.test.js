/**
 * Regression test for a missing customer notification, found by the
 * 2026-09-28 Interactions module audit.
 *
 * The customer-side `sendMessage` (controllers/user/interactionController.js)
 * has always notified the other party of a new chat message via
 * util/notificationHelper.js's createNotification(). The vendor-side
 * counterpart, `sendVendorMessage`, never did -- it only emitted the socket
 * event. A customer therefore got no notification (and no unread-notification
 * badge) when a vendor replied in a booking chat unless they already had the
 * chat screen open and connected to the socket.
 *
 * Reproduced end-to-end against a real database in
 * tests/audit/interactions.flow.mjs (the customer's notification list was
 * empty after a vendor reply). Fixed by making sendVendorMessage look up the
 * conversation's booking owner and call createNotification the same way the
 * customer-side handler does.
 *
 * See tests/regressions/vendorNotificationIdor.test.js for the file
 * convention this follows.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    conversation: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    message: {
      create: jest.fn(),
    },
  },
}));

jest.unstable_mockModule('../../socket.js', () => ({
  getIO: () => ({ to: () => ({ emit: jest.fn() }) }),
}));

const createNotification = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../util/notificationHelper.js', () => ({
  createNotification,
}));

const prisma = (await import('../../util/prisma.js')).default;
const { sendVendorMessage } = await import('../../controllers/vendor/interactionController.js');

const VENDOR_ID = 501;
const CUSTOMER_ID = 42;
const CONVERSATION_ID = 7;
const BOOKING_ID = 99;

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  createNotification.mockResolvedValue(undefined);
});

describe('sendVendorMessage notifies the customer (regression)', () => {
  test('a vendor message creates a notification for the booking owner', async () => {
    prisma.conversation.findUnique
      // Ownership check lookup
      .mockResolvedValueOnce({ booking: { service: { vendorId: VENDOR_ID } } })
      // Post-send lookup used to find the receiver
      .mockResolvedValueOnce({ booking: { id: BOOKING_ID, userId: CUSTOMER_ID } });
    prisma.message.create.mockResolvedValue({ id: 1, conversationId: CONVERSATION_ID, message_text: 'On my way!' });
    prisma.conversation.update.mockResolvedValue({});

    const req = {
      body: { conversationId: CONVERSATION_ID, message_text: 'On my way!' },
      user: { id: VENDOR_ID },
    };
    const res = mockRes();

    await sendVendorMessage(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification.mock.calls[0][0]).toBe(CUSTOMER_ID);
  });

  test('a socket/notification failure does not fail the request', async () => {
    prisma.conversation.findUnique
      .mockResolvedValueOnce({ booking: { service: { vendorId: VENDOR_ID } } })
      .mockRejectedValueOnce(new Error('db blip'));
    prisma.message.create.mockResolvedValue({ id: 1, conversationId: CONVERSATION_ID, message_text: 'hi' });
    prisma.conversation.update.mockResolvedValue({});

    const req = {
      body: { conversationId: CONVERSATION_ID, message_text: 'hi' },
      user: { id: VENDOR_ID },
    };
    const res = mockRes();

    await sendVendorMessage(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
  });
});
