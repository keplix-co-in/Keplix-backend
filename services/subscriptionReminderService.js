/**
 * Garage subscription reminders (2026-11-22 subscription decision), run by the
 * in-process dispatcher in util/bookingStatusManager.js.
 *
 * - Ensures approved vendors without a subscription row get their lazy trial.
 * - Reminds at 7, 3 and 1 day(s) before ends_at, then once a day through the
 *   7-day grace window.
 * - Idempotent: each reminder is CLAIMED with a guarded updateMany on
 *   last_reminder_at (null, or older than MIN_GAP_MS) before sending, so the
 *   10-minute tick, a restart, or overlapping runs never double-send. A claimed
 *   reminder whose send fails is not retried (a missed nudge beats a duplicate).
 */
import prisma from '../util/prisma.js';
import { addNotificationJob } from '../queues/notificationQueue.js';
import { renderNotification, NOTIFICATION_TYPES } from '../util/notificationTemplates.js';
import { GRACE_DAYS, getOrCreateSubscription } from '../util/subscription.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// 24h, not 20h: the "7 days left" bucket (ceil of days) is 24h wide and the first
// claim lands at its start, so a 20h gap let the SAME reminder fire again ~20h later.
const MIN_GAP_MS = 24 * 60 * 60 * 1000;
const PRE_EXPIRY_MARKS = [7, 3, 1];

/** Pure: the reminder (if any) due for a subscription ending at endsAt. */
export const reminderDue = (endsAt, now) => {
  const diff = new Date(endsAt).getTime() - now.getTime();
  if (diff > 0) {
    const daysLeft = Math.ceil(diff / DAY_MS);
    return PRE_EXPIRY_MARKS.includes(daysLeft) ? { daysLeft, graceDaysLeft: null } : null;
  }
  const graceLeft = Math.ceil((new Date(endsAt).getTime() + GRACE_DAYS * DAY_MS - now.getTime()) / DAY_MS);
  if (graceLeft <= 0) return null; // already expired: hidden, no more nagging
  return { daysLeft: 0, graceDaysLeft: graceLeft };
};

export const sendSubscriptionReminders = async (now = new Date()) => {
  let sent = 0;
  let created = 0;

  const missing = await prisma.user.findMany({
    where: { role: 'vendor', vendorProfile: { is: { status: 'approved' } }, vendorSubscription: { is: null } },
    select: { id: true },
    take: 500,
  });
  for (const v of missing) {
    try {
      await getOrCreateSubscription(v.id, now);
      created += 1;
    } catch (err) {
      console.error(`[subscriptions] trial create failed for vendor ${v.id}:`, err?.message);
    }
  }

  const candidates = await prisma.vendorSubscription.findMany({
    where: {
      ends_at: { gt: new Date(now.getTime() - GRACE_DAYS * DAY_MS), lte: new Date(now.getTime() + 7 * DAY_MS) },
      OR: [{ last_reminder_at: null }, { last_reminder_at: { lt: new Date(now.getTime() - MIN_GAP_MS) } }],
    },
    select: { id: true, vendorId: true, ends_at: true },
    take: 500,
  });

  for (const sub of candidates) {
    const due = reminderDue(sub.ends_at, now);
    if (!due) continue;
    const { count } = await prisma.vendorSubscription.updateMany({
      where: {
        id: sub.id,
        OR: [{ last_reminder_at: null }, { last_reminder_at: { lt: new Date(now.getTime() - MIN_GAP_MS) } }],
      },
      data: { last_reminder_at: now },
    });
    if (count === 0) continue;
    try {
      const n = renderNotification(NOTIFICATION_TYPES.SUBSCRIPTION_REMINDER, due);
      await addNotificationJob({
        type: n.type,
        recipientId: sub.vendorId,
        title: n.title,
        body: n.body,
        metadata: { type: n.type, data: n.data },
      });
      sent += 1;
    } catch (err) {
      console.error(`[subscriptions] reminder failed for vendor ${sub.vendorId}:`, err?.message);
    }
  }
  return { sent, created };
};
