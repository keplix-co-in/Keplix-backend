/**
 * READ-ONLY. Lists bookings that have a successful online Payment but are not
 * in a final state. Written for the 2026-11-22 switch to pay-the-garage: these
 * are customers who paid through the platform before the switch and whose
 * bookings are still open, so the owner can settle or refund them by hand.
 *
 * Usage: node scripts/listPaidUnfinishedBookings.js   (prints only; never writes)
 */
import 'dotenv/config';
import prisma from '../util/prisma.js';

const FINAL_STATUSES = ['user_confirmed', 'cancelled', 'rejected', 'expired', 'completed'];

const main = async () => {
  const rows = await prisma.booking.findMany({
    where: { payment: { is: { status: 'success' } }, status: { notIn: FINAL_STATUSES } },
    select: {
      id: true,
      status: true,
      userId: true,
      booking_date: true,
      service: { select: { vendorId: true, name: true } },
      payment: { select: { id: true, amount: true, vendorPayoutStatus: true } },
    },
    orderBy: { id: 'asc' },
  });
  console.log(`Paid but unfinished bookings: ${rows.length}`);
  for (const b of rows) {
    console.log(
      [`booking=${b.id}`, `status=${b.status}`, `customer=${b.userId}`, `vendor=${b.service?.vendorId}`,
        `payment=${b.payment?.id}`, `amount=${b.payment?.amount?.toString()}`, `payout=${b.payment?.vendorPayoutStatus}`].join(' ')
    );
  }
};

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
