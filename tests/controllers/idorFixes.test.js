import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Shared prisma mock used by every controller under test here. Each test file
// section imports the controller(s) it needs after mocking, per the
// unstable_mockModule idiom used elsewhere in this repo (see
// tests/controllers/user/serviceConfirmation.test.js).
// ---------------------------------------------------------------------------

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    booking: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    payment: {
      update: jest.fn(),
      aggregate: jest.fn(),
    },
    review: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    conversation: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    message: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
    notification: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    promotion: {
      findMany: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

jest.unstable_mockModule('../../queues/payoutQueue.js', () => ({
  addPayoutJob: jest.fn(),
}));

jest.unstable_mockModule('../../util/notificationHelper.js', () => ({
  createNotification: jest.fn(),
  sendPushNotification: jest.fn(),
}));

jest.unstable_mockModule('../../util/ratingHelper.js', () => ({
  updateVendorRatingStats: jest.fn(),
}));

jest.unstable_mockModule('../../util/notificationTemplates.js', () => ({
  renderNotification: jest.fn(() => ({ title: 't', body: 'b', data: {}, type: 'x' })),
  NOTIFICATION_TYPES: { SERVICE_DISPUTED: 'SERVICE_DISPUTED', NEW_MESSAGE: 'NEW_MESSAGE' },
}));

jest.unstable_mockModule('../../socket.js', () => ({
  getIO: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })),
}));

jest.unstable_mockModule('../../util/refundView.js', () => ({
  buildRefundView: jest.fn(() => null),
  REFUND_ETA_TEXT: 'a few days',
}));

jest.unstable_mockModule('../../queues/notificationQueue.js', () => ({
  addNotificationJob: jest.fn(),
}));

jest.unstable_mockModule('../../util/servicePricing.js', () => ({
  resolveServiceAmount: jest.fn(),
}));

jest.unstable_mockModule('../../services/refundPolicy.js', () => ({
  executeCancellationRefund: jest.fn(),
  resolveCancellationRefund: jest.fn(),
}));

jest.unstable_mockModule('../../util/slots.js', () => ({
  generateSlots: jest.fn(),
  isHoliday: jest.fn(),
  minutesToLabel: jest.fn(),
  parseTimeToMinutes: jest.fn(),
  toCanonicalTime: jest.fn(),
}));

jest.unstable_mockModule('../../util/time.js', () => ({
  getISTDate: jest.fn(),
}));

const prisma = (await import('../../util/prisma.js')).default;

const { confirmServiceCompletion, disputeServiceCompletion } = await import(
  '../../controllers/user/serviceConfirmationController.js'
);
const { getSingleBooking } = await import('../../controllers/user/bookingController.js');
const { getVendorEarnings } = await import('../../controllers/vendor/paymentController.js');
const { getMessages, sendMessage } = await import('../../controllers/user/interactionController.js');
const { getVendorMessages, sendVendorMessage } = await import(
  '../../controllers/vendor/interactionController.js'
);
const { getNotifications, markRead } = await import('../../controllers/user/notificationController.js');
const { getPromotions } = await import('../../controllers/vendor/promotionController.js');

const mockRes = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. confirmServiceCompletion
// ---------------------------------------------------------------------------
describe('confirmServiceCompletion (IDOR)', () => {
  const buildReq = (callerId) => ({
    params: { userId: '999', id: '100' }, // attacker puts someone else's id in the URL
    body: { confirmed: true },
    user: { id: callerId },
  });

  test('rejects when caller does not own the booking', async () => {
    prisma.booking.findUnique.mockResolvedValue({ userId: 5 }); // owned by user 5
    const req = buildReq(7); // caller is user 7, not the owner
    const res = mockRes();
    await confirmServiceCompletion(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('succeeds when caller owns the booking (via req.user.id, not params)', async () => {
    const mockBooking = {
      id: 100,
      userId: 7,
      status: 'service_completed',
      service: { vendorId: 10, name: 'Plumbing' },
      payment: { id: 50, status: 'success', vendorAmount: 400, vendorPayoutStatus: 'pending' },
    };
    prisma.booking.findUnique.mockResolvedValue(mockBooking);
    prisma.$transaction.mockImplementation(async (callback) => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        booking: { findUnique: jest.fn().mockResolvedValue(mockBooking), update: jest.fn() },
        payment: { update: jest.fn() },
        review: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
        refund: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      return callback(tx);
    });

    const req = buildReq(7); // matches booking.userId
    const res = mockRes();
    await confirmServiceCompletion(req, res);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});

// ---------------------------------------------------------------------------
// 3. disputeServiceCompletion
// ---------------------------------------------------------------------------
describe('disputeServiceCompletion (IDOR)', () => {
  const buildReq = (callerId) => ({
    params: { userId: '999', id: '100' },
    body: { reason: 'Service was not completed properly at all' },
    user: { id: callerId },
  });

  test('rejects when caller does not own the booking', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      userId: 5,
      status: 'service_completed',
      service: { vendorId: 10, name: 'Plumbing' },
    });
    const req = buildReq(7);
    const res = mockRes();
    await disputeServiceCompletion(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('succeeds when caller owns the booking', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      userId: 7,
      status: 'service_completed',
      service: { vendorId: 10, name: 'Plumbing' },
    });
    prisma.booking.update.mockResolvedValue({});
    prisma.user.findUnique.mockResolvedValue({ pushToken: null, email: 'v@x.com' });

    const req = buildReq(7);
    const res = mockRes();
    await disputeServiceCompletion(req, res);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});

// ---------------------------------------------------------------------------
// 2. getSingleBooking
// ---------------------------------------------------------------------------
describe('getSingleBooking (IDOR)', () => {
  test('returns 404 (not another user\'s booking) when caller does not own it', async () => {
    // findFirst is filtered by userId: req.user.id -- a mismatched caller
    // simply finds nothing, which is the correct behavior we're verifying by
    // asserting the query itself was scoped to the caller's id.
    prisma.booking.findFirst.mockResolvedValue(null);

    const req = { params: { userId: '999', id: '100' }, user: { id: 7 } };
    const res = mockRes();
    await getSingleBooking(req, res);

    expect(prisma.booking.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 100, userId: 7 }) })
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('succeeds and scopes the query to req.user.id when caller owns it', async () => {
    const mockBooking = { id: 100, userId: 7, payment: null };
    prisma.booking.findFirst.mockResolvedValue(mockBooking);

    const req = { params: { userId: '999', id: '100' }, user: { id: 7 } };
    const res = mockRes();
    await getSingleBooking(req, res);

    expect(prisma.booking.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 100, userId: 7 }) })
    );
    expect(res.status).not.toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 100 }));
  });
});

// ---------------------------------------------------------------------------
// 4. getVendorEarnings
// ---------------------------------------------------------------------------
describe('getVendorEarnings (IDOR)', () => {
  test('rejects when caller is not the vendor named in the URL', async () => {
    const req = { params: { vendor_id: '999' }, user: { id: 7 } };
    const res = mockRes();
    await getVendorEarnings(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(prisma.payment.aggregate).not.toHaveBeenCalled();
  });

  test('succeeds when caller is the vendor named in the URL', async () => {
    prisma.payment.aggregate.mockResolvedValue({ _sum: { vendorAmount: 0 } });
    const req = { params: { vendor_id: '7' }, user: { id: 7 } };
    const res = mockRes();
    await getVendorEarnings(req, res);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ total_earnings: 0 }));
  });
});

// ---------------------------------------------------------------------------
// 5. getMessages (user)
// ---------------------------------------------------------------------------
describe('getMessages (IDOR)', () => {
  test('rejects when the conversation booking belongs to another user', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ booking: { userId: 5 } });
    const req = { params: { conversationId: '1' }, query: {}, user: { id: 7 } };
    const res = mockRes();
    await getMessages(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  test('succeeds when the caller owns the conversation booking', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ booking: { userId: 7 } });
    prisma.message.findMany.mockResolvedValue([]);
    const req = { params: { conversationId: '1' }, query: {}, user: { id: 7 } };
    const res = mockRes();
    await getMessages(req, res);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});

// ---------------------------------------------------------------------------
// 6. sendMessage (user)
// ---------------------------------------------------------------------------
describe('sendMessage (IDOR)', () => {
  test('rejects when the conversation booking belongs to another user', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ booking: { userId: 5 } });
    const req = { body: { conversationId: 1, message_text: 'hi' }, user: { id: 7 } };
    const res = mockRes();
    await sendMessage(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  test('succeeds when the caller owns the conversation booking', async () => {
    prisma.conversation.findUnique
      .mockResolvedValueOnce({ booking: { userId: 7 } }) // ownership check
      .mockResolvedValueOnce({ booking: { userId: 7, id: 1, service: { vendorId: 10 } } }); // post-send lookup
    prisma.message.create.mockResolvedValue({ id: 1, message_text: 'hi' });
    prisma.conversation.update.mockResolvedValue({});

    const req = { body: { conversationId: 1, message_text: 'hi' }, user: { id: 7 } };
    const res = mockRes();
    await sendMessage(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

// ---------------------------------------------------------------------------
// 7. getVendorMessages
// ---------------------------------------------------------------------------
describe('getVendorMessages (IDOR)', () => {
  test('rejects when the conversation booking is for another vendor', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ booking: { service: { vendorId: 5 } } });
    const req = { params: { conversationId: '1' }, query: {}, user: { id: 7 } };
    const res = mockRes();
    await getVendorMessages(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  test('succeeds when the caller is the vendor for the booking', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ booking: { service: { vendorId: 7 } } });
    prisma.message.findMany.mockResolvedValue([]);
    const req = { params: { conversationId: '1' }, query: {}, user: { id: 7 } };
    const res = mockRes();
    await getVendorMessages(req, res);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith([]);
  });
});

// ---------------------------------------------------------------------------
// 8. sendVendorMessage
// ---------------------------------------------------------------------------
describe('sendVendorMessage (IDOR)', () => {
  test('rejects when the conversation booking is for another vendor', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ booking: { service: { vendorId: 5 } } });
    const req = { body: { conversationId: 1, message_text: 'hi' }, user: { id: 7 } };
    const res = mockRes();
    await sendVendorMessage(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  test('succeeds when the caller is the vendor for the booking', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ booking: { service: { vendorId: 7 } } });
    prisma.message.create.mockResolvedValue({ id: 1, message_text: 'hi' });
    prisma.conversation.update.mockResolvedValue({});

    const req = { body: { conversationId: 1, message_text: 'hi' }, user: { id: 7 } };
    const res = mockRes();
    await sendVendorMessage(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

// ---------------------------------------------------------------------------
// 9. getNotifications
// ---------------------------------------------------------------------------
describe('getNotifications (IDOR)', () => {
  test('rejects when caller is not the user_id in the URL', async () => {
    const req = { params: { user_id: '999' }, query: {}, user: { id: 7 } };
    const res = mockRes();
    await getNotifications(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(prisma.notification.findMany).not.toHaveBeenCalled();
  });

  test('succeeds when caller matches the user_id in the URL', async () => {
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);
    const req = { params: { user_id: '7' }, query: {}, user: { id: 7 } };
    const res = mockRes();
    await getNotifications(req, res);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ notifications: [] }));
  });
});

// ---------------------------------------------------------------------------
// 10. markRead
// ---------------------------------------------------------------------------
describe('markRead (IDOR)', () => {
  test('returns 404 when the notification belongs to another user', async () => {
    prisma.notification.findUnique.mockResolvedValue({ id: 1, userId: 5 });
    const req = { params: { id: '1' }, user: { id: 7 } };
    const res = mockRes();
    await markRead(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });

  test('succeeds when the notification belongs to the caller', async () => {
    prisma.notification.findUnique.mockResolvedValue({ id: 1, userId: 7 });
    prisma.notification.update.mockResolvedValue({ id: 1, userId: 7, is_read: true });
    const req = { params: { id: '1' }, user: { id: 7 } };
    const res = mockRes();
    await markRead(req, res);
    expect(res.status).not.toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ is_read: true }));
  });
});

// ---------------------------------------------------------------------------
// 11. getPromotions
// ---------------------------------------------------------------------------
describe('getPromotions (IDOR)', () => {
  test('rejects when caller is not the vendor in the URL', async () => {
    const req = { params: { vendorId: '999' }, user: { id: 7 } };
    const res = mockRes();
    await getPromotions(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(prisma.promotion.findMany).not.toHaveBeenCalled();
  });

  test('succeeds when caller matches the vendor in the URL', async () => {
    prisma.promotion.findMany.mockResolvedValue([]);
    const req = { params: { vendorId: '7' }, user: { id: 7 } };
    const res = mockRes();
    await getPromotions(req, res);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith([]);
  });
});
