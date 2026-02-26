
import prisma from '../util/prisma.js';



async function main() {
  console.log('Starting backfill of missing conversations...');

  // Get all bookings
  const bookings = await prisma.booking.findMany({
    include: { conversation: true }
  });

  let count = 0;
  for (const booking of bookings) {
    if (!booking.conversation) {
      console.log(`Creating conversation for Booking ID: ${booking.id}`);
      try {
        await prisma.conversation.create({
          data: {
            bookingId: booking.id,
            updatedAt: new Date()
          }
        });
        count++;
      } catch (e) {
        console.error(`Failed to create conversation for booking ${booking.id}: ${e.message}`);
      }
    }
  }

  console.log(`Backfill complete. Created ${count} conversations.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

