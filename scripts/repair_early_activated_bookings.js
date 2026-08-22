/**
 * One-off repair for bookings activated before their time.
 *
 * Until this was fixed, bookingStatusManager.parseBookingDateTime() had no
 * AM/PM handling, so a legacy free-text booking_time of "3:00 PM" parsed as
 * 03:00. The activation cron's +/-5 minute window then fired at 3am and moved
 * the booking to in_progress, where it stayed for the rest of the day -- which
 * is what put 3pm bookings under the customer app's "Ongoing" tab from dawn
 * onwards. Fixing the parser stops new rows going wrong; it cannot rescue rows
 * already sitting in the wrong state, which is what this does.
 *
 * Only touches bookings whose CORRECTLY parsed start time is still in the
 * future -- a genuinely in-progress job is never in that set, so this cannot
 * reverse real work. Sends them back to 'confirmed'.
 *
 * Usage:
 *   node scripts/repair_early_activated_bookings.js          # dry run, prints only
 *   node scripts/repair_early_activated_bookings.js --apply  # actually writes
 */
import prisma from '../util/prisma.js';
import bookingStatusManager from '../util/bookingStatusManager.js';

const apply = process.argv.includes('--apply');

const run = async () => {
  const now = new Date();

  const candidates = await prisma.booking.findMany({
    where: { status: 'in_progress', vendor_status: 'accepted' },
    select: { id: true, booking_date: true, booking_time: true, updatedAt: true },
  });

  const wrong = [];
  for (const b of candidates) {
    const startsAt = bookingStatusManager.parseBookingDateTime(b.booking_date, b.booking_time);
    // Unparseable times are left alone deliberately: without a trustworthy
    // start time there is no basis for calling this booking wrongly activated.
    if (!startsAt) continue;
    if (startsAt.getTime() > now.getTime()) {
      wrong.push({ id: b.id, booking_time: b.booking_time, startsAt });
    }
  }

  if (wrong.length === 0) {
    console.log('No wrongly-activated bookings found.');
    return;
  }

  console.log(`${wrong.length} booking(s) are in_progress but start in the future:`);
  for (const w of wrong) {
    console.log(`  #${w.id}  booking_time=${JSON.stringify(w.booking_time)}  starts ${w.startsAt.toISOString()}`);
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to move these back to "confirmed".');
    return;
  }

  const result = await prisma.booking.updateMany({
    where: { id: { in: wrong.map((w) => w.id) }, status: 'in_progress' },
    data: { status: 'confirmed', updatedAt: new Date() },
  });
  console.log(`\nReverted ${result.count} booking(s) to "confirmed".`);
};

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
