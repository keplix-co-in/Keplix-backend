import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log("🚀 Starting Live Traffic Simulation...");
    console.log("Waiting for user1 and vendor1...");

    // Find User1 and Vendor1
    const user1 = await prisma.user.findFirst({ where: { email: 'user1@example.com' } });
    const vendor1 = await prisma.user.findFirst({ where: { email: 'vendor1@example.com' } });

    if (!user1 || !vendor1) {
        console.error("❌ Error: user1 or vendor1 not found. Please run 'npm run prisma:seed' first.");
        return;
    }

    // Get a service
    const service = await prisma.service.findFirst({ where: { vendorId: vendor1.id } });

    if (!service) {
        console.error("❌ Error: No services found for vendor1.");
        return;
    }

    console.log(`✅ Targeted: ${user1.email} -> ${vendor1.email} (${service.name})`);
    console.log("⚡ Broadcasting new booking every 5 seconds. Press Ctrl+C to stop.");

    let count = 1;

    setInterval(async () => {
        try {
            const booking = await prisma.booking.create({
                data: {
                    userId: user1.id,
                    serviceId: service.id,
                    booking_date: new Date(), // TODAY
                    booking_time: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
                    status: 'pending',
                    vendor_status: 'pending',
                    notes: `Live Traffic Test Booking #${count}`,
                    createdAt: new Date(),
                    updatedAt: new Date()
                }
            });

            console.log(`[${new Date().toLocaleTimeString()}] 📦 Booking #${count} Created [ID: ${booking.id}] -> Status: Pending`);
            count++;
        } catch (error) {
            console.error("Error creating booking:", error);
        }
    }, 5000);
}

main().catch(e => console.error(e));
