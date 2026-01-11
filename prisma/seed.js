import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const categories = ["Cleaning", "Plumbing", "Electrical", "Beauty", "Painting", "Moving", "Pest Control", "Carpentry", "Event Planning"];
const locations = ["New York, NY", "Los Angeles, CA", "Chicago, IL", "Houston, TX", "Phoenix, AZ", "Philadelphia, PA", "San Antonio, TX", "San Diego, CA"];
const serviceNames = [
    "Deep Cleaning", "Standard Cleaning", "Pipe Repair", "Leak Fix", "Wiring Installation", "Switch Replacement",
    "Haircut", "Manicure", "Wall Painting", "Furniture Moving", "Termite Control", "Table Repair"
];
const firstNames = ["John", "Jane", "Alice", "Bob", "Charlie", "Diana", "Ethan", "Fiona", "George", "Hannah", "Ian", "Julia"];
const lastNames = ["Smith", "Doe", "Johnson", "Brown", "Williams", "Jones", "Garcia", "Miller", "Davis", "Rodriguez"];

function getRandomElement(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getRandomDate(start, end) {
    return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}

async function main() {
    console.log('Start seeding ...');

    // Cleanup existing data
    await prisma.feedback.deleteMany();
    await prisma.notification.deleteMany();
    await prisma.message.deleteMany();
    await prisma.conversation.deleteMany();
    await prisma.review.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.booking.deleteMany();
    await prisma.service.deleteMany();
    await prisma.inventory.deleteMany();
    await prisma.availability.deleteMany();
    await prisma.document.deleteMany();
    await prisma.promotion.deleteMany();
    await prisma.vendorProfile.deleteMany();
    await prisma.userProfile.deleteMany();
    await prisma.user.deleteMany();

    const hashedPassword = await bcrypt.hash('password123', 10);

    // Creates 100 Vendors
    const vendors = [];
    
    // Create specific test vendor
    const testVendor = await prisma.user.create({
        data: {
            email: "vendor@example.com",
            password: hashedPassword,
            role: 'vendor',
            is_active: true,
            vendorProfile: {
                create: {
                    business_name: "Keplix Official Services",
                    phone: "555-0000",
                    email: "vendor@example.com",
                    address: "123 Tech Park, CA",
                    operating_hours: "09:00 AM - 09:00 PM",
                    status: "approved",
                    onboarding_completed: true,
                    latitude: 40.7128,
                    longitude: -74.0060,
                }
            },
            services: {
                create: [
                    {
                        name: "Premium Full Home Cleaning",
                        description: "Top tier cleaning service.",
                        price: 150,
                        duration: 180,
                        category: "Cleaning",
                        image_url: "https://via.placeholder.com/150"
                    }
                ]
            }
        },
        include: { services: true }
    });
    vendors.push(testVendor);
    console.log("Created test vendor: vendor@example.com");

    for (let i = 1; i <= 100; i++) {
        const email = `vendor${i}@example.com`;
        const firstName = getRandomElement(firstNames);
        const lastName = getRandomElement(lastNames);
        const businessName = `${lastName} ${getRandomElement(categories)} Services`;

        const vendor = await prisma.user.create({
            data: {
                email,
                password: hashedPassword,
                role: 'vendor',
                is_active: true,
                vendorProfile: {
                    create: {
                        business_name: businessName,
                        phone: `555-01${getRandomInt(10, 99)}`,
                        email: email,
                        address: getRandomElement(locations),
                        operating_hours: "09:00 AM - 06:00 PM",
                        status: "approved",
                        onboarding_completed: true,
                        latitude: 40.7128 + (Math.random() - 0.5),
                        longitude: -74.0060 + (Math.random() - 0.5),
                    }
                },
                services: {
                    create: Array.from({ length: getRandomInt(5, 12) }).map(() => ({
                        name: getRandomElement(serviceNames),
                        description: "High quality professional service with satisfaction guaranteed.",
                        price: getRandomInt(50, 300),
                        duration: getRandomInt(30, 120),
                        category: getRandomElement(categories),
                        image_url: "https://via.placeholder.com/150"
                    }))
                },
                inventory: {
                    create: {
                        item_name: "Standard Tools Kit",
                        stock_level: getRandomInt(5, 50)
                    }
                },
                promotions: {
                    create: {
                        title: "Seasonal Discount",
                        description: "Get 15% off this month",
                        discount: 15.0,
                        start_date: new Date(),
                        end_date: new Date(new Date().setMonth(new Date().getMonth() + 1))
                    }
                },
                Availability: {
                    createMany: {
                        data: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map(day => ({
                            day_of_week: day,
                            start_time: "09:00",
                            end_time: "18:00",
                            is_available: true
                        }))
                    }
                },
                documents: {
                    create: {
                        document_type: "Business License",
                        file_url: "https://example.com/license.pdf",
                        status: "approved"
                    }
                }
            },
            include: {
                services: true
            }
        });
        vendors.push(vendor);
        console.log(`Created vendor ${i}: ${email}`);
    }

    // Creates 200 Users
    const users = [];

    // Create specific test user
    const testUser = await prisma.user.create({
        data: {
            email: "priya.sharma@customer.com",
            password: hashedPassword,
            role: 'user',
            is_active: true,
            userProfile: {
                create: {
                    name: "Priya Sharma",
                    phone: "555-0199",
                    address: "New York, NY"
                }
            }
        }
    });
    users.push(testUser);
    console.log("Created test user: priya.sharma@customer.com");

    for (let i = 1; i <= 200; i++) {
        const email = `user${i}@example.com`;
        const firstName = getRandomElement(firstNames);
        const lastName = getRandomElement(lastNames);

        const user = await prisma.user.create({
            data: {
                email,
                password: hashedPassword,
                role: 'user',
                is_active: true,
                userProfile: {
                    create: {
                        name: `${firstName} ${lastName}`,
                        phone: `555-02${getRandomInt(10, 99)}`,
                        address: getRandomElement(locations)
                    }
                },
                notifications: {
                    create: {
                        title: "Welcome to Keplix!",
                        message: "Thanks for joining us.",
                        is_read: false
                    }
                },
                feedbacks: {
                    create: {
                        title: "Great App",
                        message: "I really like the interface.",
                        category: "UX"
                    }
                }
            }
        });
        users.push(user);
        console.log(`Created user ${i}: ${email}`);
    }

    // Create Bookings, Payments, Reviews
    console.log('Creating Bookings and Interactions...');
    
    // Ensure every user has some bookings
    for (const user of users) {
        // Each user makes 10-20 bookings
        const numBookings = getRandomInt(10, 20);
        
        for (let j = 0; j < numBookings; j++) {
            const randomVendor = getRandomElement(vendors);
            if (randomVendor.services.length === 0) continue;
            
            const randomService = getRandomElement(randomVendor.services);
            await createBookingTransaction(user, randomVendor, randomService);
        }
    }

    // Ensure every vendor has at least some bookings
    for (const vendor of vendors) {
        // Each vendor gets 15-30 guaranteed extra bookings from random users
        const numExtraBookings = getRandomInt(15, 30);
        if (vendor.services.length === 0) continue;

        for (let k = 0; k < numExtraBookings; k++) {
            const randomUser = getRandomElement(users);
            const randomService = getRandomElement(vendor.services);
            await createBookingTransaction(randomUser, vendor, randomService);
        }
    }

    // Special massive booking set for Test Vendor to ensure they are busy
    const testVendorRef = vendors.find(v => v.email === "vendor@example.com");
    if (testVendorRef && testVendorRef.services.length > 0) {
        console.log("Injecting 50+ extra bookings for Test Vendor...");
        for (let m = 0; m < 80; m++) {
            const randomUser = getRandomElement(users);
            const randomService = getRandomElement(testVendorRef.services);
            await createBookingTransaction(randomUser, testVendorRef, randomService);
        }
    }

    console.log('Seeding finished.');
}

async function createBookingTransaction(user, vendor, service) {
    const isCompleted = Math.random() > 0.4; // 60% completed
    const status = isCompleted ? 'completed' : ((Math.random() > 0.5) ? 'pending' : 'accepted');
    const bookingDate = getRandomDate(new Date(2025, 0, 1), new Date(2026, 11, 31));

    const booking = await prisma.booking.create({
        data: {
            userId: user.id,
            serviceId: service.id,
            booking_date: bookingDate,
            booking_time: `${getRandomInt(9, 17)}:00`,
            status: status,
            notes: "Please enter through the side gate.",
            payment: {
                create: {
                    amount: service.price,
                    status: isCompleted ? 'paid' : 'pending',
                    method: "Credit Card",
                    transactionId: isCompleted ? `txn_${getRandomInt(10000, 99999)}` : null
                }
            },
            conversation: {
                create: {
                    messages: {
                        create: [
                            {
                                senderId: user.id,
                                message_text: "Hi, is this service available?"
                            },
                            {
                                senderId: vendor.id,
                                message_text: "Yes, we are available!"
                            }
                        ]
                    }
                }
            }
        }
    });

    if (isCompleted) {
        await prisma.review.create({
            data: {
                bookingId: booking.id,
                userId: user.id,
                rating: getRandomInt(3, 5),
                comment: "Service was great, would recommend!"
            }
        });
    }
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });


// node prisma/seed.js
