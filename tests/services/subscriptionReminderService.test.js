import { jest } from '@jest/globals';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-23T10:00:00.000Z');

const prisma = {
  user: { findMany: jest.fn() },
  vendorSubscription: { findMany: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
};
const addNotificationJob = jest.fn(async () => ({ id: 1 }));
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: prisma }));
jest.unstable_mockModule('../../queues/notificationQueue.js', () => ({ addNotificationJob, default: addNotificationJob }));

const { sendSubscriptionReminders, reminderDue } = await import('../../services/subscriptionReminderService.js');

const endsIn = (ms) => new Date(NOW.getTime() + ms);

beforeEach(() => {
  jest.clearAllMocks();
  prisma.user.findMany.mockResolvedValue([]);
  prisma.vendorSubscription.findMany.mockResolvedValue([]);
  prisma.vendorSubscription.updateMany.mockResolvedValue({ count: 1 });
});

describe('reminderDue (pure)', () => {
  test('fires at 7, 3 and 1 days before ends_at, not on other days', () => {
    expect(reminderDue(endsIn(7 * DAY - 1000), NOW)).toEqual({ daysLeft: 7, graceDaysLeft: null });
    expect(reminderDue(endsIn(3 * DAY - 1000), NOW)).toEqual({ daysLeft: 3, graceDaysLeft: null });
    expect(reminderDue(endsIn(1 * DAY - 1000), NOW)).toEqual({ daysLeft: 1, graceDaysLeft: null });
    expect(reminderDue(endsIn(5 * DAY - 1000), NOW)).toBeNull();
    expect(reminderDue(endsIn(2 * DAY - 1000), NOW)).toBeNull();
  });

  test('daily through the grace window, with the grace days remaining', () => {
    expect(reminderDue(endsIn(0), NOW)).toEqual({ daysLeft: 0, graceDaysLeft: 7 });
    expect(reminderDue(endsIn(-3 * DAY), NOW)).toEqual({ daysLeft: 0, graceDaysLeft: 4 });
    expect(reminderDue(endsIn(-7 * DAY + 1000), NOW)).toEqual({ daysLeft: 0, graceDaysLeft: 1 });
  });

  test('no reminder once expired (ends_at + 7d reached)', () => {
    expect(reminderDue(endsIn(-7 * DAY), NOW)).toBeNull();
    expect(reminderDue(endsIn(-20 * DAY), NOW)).toBeNull();
  });
});

describe('sendSubscriptionReminders', () => {
  test('claims with a guarded updateMany then sends one notification to the vendor', async () => {
    prisma.vendorSubscription.findMany.mockResolvedValue([{ id: 1, vendorId: 5, ends_at: endsIn(3 * DAY - 1000) }]);
    const out = await sendSubscriptionReminders(NOW);
    expect(out).toEqual({ sent: 1, created: 0 });
    const claim = prisma.vendorSubscription.updateMany.mock.calls[0][0];
    expect(claim.where.id).toBe(1);
    expect(claim.where.OR).toEqual([{ last_reminder_at: null }, { last_reminder_at: { lt: expect.any(Date) } }]);
    expect(claim.data).toEqual({ last_reminder_at: NOW });
    expect(addNotificationJob).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 5, type: 'subscription_reminder' }));
  });

  test('idempotent: losing the claim (already reminded within 24h) sends nothing', async () => {
    prisma.vendorSubscription.findMany.mockResolvedValue([{ id: 1, vendorId: 5, ends_at: endsIn(3 * DAY - 1000) }]);
    prisma.vendorSubscription.updateMany.mockResolvedValue({ count: 0 });
    expect((await sendSubscriptionReminders(NOW)).sent).toBe(0);
    expect(addNotificationJob).not.toHaveBeenCalled();
  });

  test('the claim gap is 24h: a reminder sent 20h ago (same ceil-day bucket) is NOT re-sent', async () => {
    await sendSubscriptionReminders(NOW);
    const { where } = prisma.vendorSubscription.findMany.mock.calls[0][0];
    const gapCutoff = where.OR[1].last_reminder_at.lt.getTime();
    expect(NOW.getTime() - gapCutoff).toBe(24 * 60 * 60 * 1000);
  });

  test('a day that is not a reminder day is skipped without even claiming', async () => {
    prisma.vendorSubscription.findMany.mockResolvedValue([{ id: 1, vendorId: 5, ends_at: endsIn(5 * DAY - 1000) }]);
    await sendSubscriptionReminders(NOW);
    expect(prisma.vendorSubscription.updateMany).not.toHaveBeenCalled();
    expect(addNotificationJob).not.toHaveBeenCalled();
  });

  test('the candidate query only looks at the grace window up to 7 days ahead, and un-reminded rows', async () => {
    await sendSubscriptionReminders(NOW);
    const { where } = prisma.vendorSubscription.findMany.mock.calls[0][0];
    expect(where.ends_at.gt.getTime()).toBe(NOW.getTime() - 7 * DAY);
    expect(where.ends_at.lte.getTime()).toBe(NOW.getTime() + 7 * DAY);
    expect(where.OR[0]).toEqual({ last_reminder_at: null });
  });

  test('approved vendors with no subscription row get their lazy trial created', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 8 }, { id: 9 }]);
    prisma.vendorSubscription.findUnique.mockResolvedValue(null);
    prisma.vendorSubscription.create.mockImplementation(async ({ data }) => data);
    const out = await sendSubscriptionReminders(NOW);
    expect(out.created).toBe(2);
    expect(prisma.user.findMany.mock.calls[0][0].where).toMatchObject({ role: 'vendor', vendorSubscription: { is: null } });
    expect(prisma.vendorSubscription.create.mock.calls[0][0].data).toMatchObject({ vendorId: 8, plan_code: 'gold', period: 'trial' });
  });

  test('a send failure is swallowed (claimed reminders are not retried)', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    prisma.vendorSubscription.findMany.mockResolvedValue([{ id: 1, vendorId: 5, ends_at: endsIn(1 * DAY - 1000) }]);
    addNotificationJob.mockRejectedValueOnce(new Error('queue down'));
    await expect(sendSubscriptionReminders(NOW)).resolves.toEqual({ sent: 0, created: 0 });
    spy.mockRestore();
  });
});
