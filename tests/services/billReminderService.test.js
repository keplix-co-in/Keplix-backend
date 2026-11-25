/**
 * Pricing v2 crons: unpaid-bill reminders are claimed before sending (never
 * twice), and the slot-time activation/expiry jobs skip v2 bookings, which
 * start at check-in and stay unpaid until the final bill.
 */
import { jest } from '@jest/globals';

const mockPrisma = {
  finalBill: { findMany: jest.fn(), updateMany: jest.fn() },
  booking: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
};
const addNotificationJob = jest.fn(async () => ({ id: 1 }));
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../queues/notificationQueue.js', () => ({ addNotificationJob, default: addNotificationJob }));
jest.unstable_mockModule('node-cron', () => ({ default: { schedule: jest.fn() } }));
jest.unstable_mockModule('../../util/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../util/notificationHelper.js', () => ({
  createNotification: jest.fn(),
  sendPushNotification: jest.fn(),
}));

const { sendBillReminders } = await import('../../services/billReminderService.js');
const manager = (await import('../../util/bookingStatusManager.js')).default;

const NOW = new Date('2026-11-20T10:00:00Z');
const bill = (over = {}) => ({ id: 5, total: '7800.00', bookingId: 100, booking: { id: 100, userId: 11, payment: null }, ...over });

beforeEach(() => jest.clearAllMocks());

describe('sendBillReminders', () => {
  test('a due bill is claimed with a guarded write, then the customer is reminded with the amount', async () => {
    mockPrisma.finalBill.findMany.mockResolvedValueOnce([bill()]).mockResolvedValueOnce([]);
    mockPrisma.finalBill.updateMany.mockResolvedValue({ count: 1 });

    const { sent } = await sendBillReminders(NOW);

    expect(sent).toBe(1);
    const [q24] = mockPrisma.finalBill.findMany.mock.calls[0];
    expect(q24.where).toMatchObject({ status: 'issued', reminder_24h_sent_at: null, issued_at: { lte: new Date(NOW.getTime() - 24 * 3600 * 1000) } });
    const [q72] = mockPrisma.finalBill.findMany.mock.calls[1];
    expect(q72.where).toMatchObject({ reminder_72h_sent_at: null, issued_at: { lte: new Date(NOW.getTime() - 72 * 3600 * 1000) } });
    expect(mockPrisma.finalBill.updateMany).toHaveBeenCalledWith({
      where: { id: 5, status: 'issued', reminder_24h_sent_at: null },
      data: { reminder_24h_sent_at: NOW },
    });
    expect(addNotificationJob).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: 11, type: 'final_bill_reminder', title: 'Your bill is waiting', body: expect.stringContaining('7,800') })
    );
  });

  test('idempotent: a reminder another run already claimed is not sent again', async () => {
    mockPrisma.finalBill.findMany.mockResolvedValueOnce([bill()]).mockResolvedValueOnce([]);
    mockPrisma.finalBill.updateMany.mockResolvedValue({ count: 0 });
    expect((await sendBillReminders(NOW)).sent).toBe(0);
    expect(addNotificationJob).not.toHaveBeenCalled();
  });

  test('a bill whose payment already succeeded is marked but not nagged', async () => {
    mockPrisma.finalBill.findMany.mockResolvedValueOnce([bill({ booking: { id: 100, userId: 11, payment: { status: 'success' } } })]).mockResolvedValueOnce([]);
    mockPrisma.finalBill.updateMany.mockResolvedValue({ count: 1 });
    expect((await sendBillReminders(NOW)).sent).toBe(0);
    expect(addNotificationJob).not.toHaveBeenCalled();
  });

  // Review fix 2026-11-21: a cancelled/disputed booking can still hold an
  // 'issued' bill, but it cannot be paid (computeCan.pay), so no reminder.
  test('only bookings the customer can still pay for (in_progress / service_completed) are reminded', async () => {
    mockPrisma.finalBill.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await sendBillReminders(NOW);
    expect(mockPrisma.finalBill.findMany).toHaveBeenCalledTimes(2);
    for (const [q] of mockPrisma.finalBill.findMany.mock.calls) {
      expect(q.where.booking).toEqual({ status: { in: ['in_progress', 'service_completed'] } });
    }
  });
});

describe('slot-time crons skip pricing v2 bookings', () => {
  test('activation and late-start queries exclude bookings with a BookingQuote', async () => {
    await manager.activateBookingsAtScheduledTime(NOW);
    await manager.handleExpiredBookings(NOW);
    expect(mockPrisma.booking.findMany).toHaveBeenCalledTimes(2);
    for (const [arg] of mockPrisma.booking.findMany.mock.calls) {
      expect(arg.where).toMatchObject({ vendor_status: 'accepted', bookingQuote: { is: null } });
    }
  });

  test('the manager wrapper never throws when reminders fail', async () => {
    mockPrisma.finalBill.findMany.mockRejectedValue(new Error('db down'));
    await expect(manager.sendBillReminders(NOW)).resolves.toBeUndefined();
  });
});
