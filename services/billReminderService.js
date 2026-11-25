/**
 * Pricing v2 unpaid-bill reminders (docs/PRICING_V2_API.md section 7), run
 * by the 10-minute job in util/bookingStatusManager.js.
 *
 * Kept apart from services/pricingV2Service.js on purpose: that module pulls
 * in socket.js (and through it the auth middleware); the cron module should
 * not load that graph just to send a reminder.
 */
import prisma from '../util/prisma.js';
import { addNotificationJob } from '../queues/notificationQueue.js';
import { renderNotification, NOTIFICATION_TYPES } from '../util/notificationTemplates.js';
import { V2_ACTIVE_STATUSES } from '../util/pricingV2.js';

const num = (v) => (v === null || v === undefined ? null : Number(v.toString()));

const REMINDERS = [
  { hours: 24, field: 'reminder_24h_sent_at' },
  { hours: 72, field: 'reminder_72h_sent_at' },
];

/**
 * Sends the 24h and 72h reminder for issued, unpaid bills. Idempotent: each
 * reminder is CLAIMED with a guarded updateMany (marker still null) before it
 * is sent, so overlapping cron runs or a restart never send it twice. A
 * claimed reminder whose send fails is not retried -- a missed nudge is
 * better than a duplicate push about money.
 */
export const sendBillReminders = async (now = new Date()) => {
  let sent = 0;
  for (const { hours, field } of REMINDERS) {
    const due = await prisma.finalBill.findMany({
      where: {
        status: 'issued',
        issued_at: { lte: new Date(now.getTime() - hours * 60 * 60 * 1000) },
        [field]: null,
        // Review fix 2026-11-21: only nag about a bill the customer can
        // actually pay. A cancelled/disputed booking can still hold an
        // 'issued' bill, but the pay button is off there (computeCan.pay uses
        // the same V2_ACTIVE_STATUSES), so a "please pay" push was wrong.
        booking: { status: { in: V2_ACTIVE_STATUSES } },
      },
      select: {
        id: true,
        total: true,
        bookingId: true,
        booking: { select: { id: true, userId: true, payment: { select: { status: true } } } },
      },
      take: 200,
    });

    for (const bill of due) {
      const { count } = await prisma.finalBill.updateMany({
        where: { id: bill.id, status: 'issued', [field]: null },
        data: { [field]: now },
      });
      if (count === 0) continue;
      if (bill.booking?.payment?.status === 'success') continue;
      try {
        const n = renderNotification(NOTIFICATION_TYPES.FINAL_BILL_REMINDER, {
          bookingId: bill.bookingId,
          amount: num(bill.total),
        });
        await addNotificationJob({
          type: n.type,
          recipientId: bill.booking.userId,
          title: n.title,
          body: n.body,
          metadata: { type: n.type, data: n.data, bookingId: bill.bookingId },
        });
        sent += 1;
      } catch (err) {
        console.error(`[pricingV2] bill reminder ${hours}h failed for bill ${bill.id}:`, err?.message);
      }
    }
  }
  return { sent };
};
