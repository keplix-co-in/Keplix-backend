import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const categories = ["Cleaning", "Plumbing", "Electrical", "Beauty", "Painting", "Moving", "Pest Control", "Carpentry", "Event Planning"];
const locations = [
  { address: "123 Broadway, New York, NY", lat: 40.7128, lng: -74.0060, city: "New York", state: "NY" },
  { address: "456 Sunset Blvd, Los Angeles, CA", lat: 34.0522, lng: -118.2437, city: "Los Angeles", state: "CA" },
  { address: "789 Michigan Ave, Chicago, IL", lat: 41.8781, lng: -87.6298, city: "Chicago", state: "IL" },
  { address: "101 Main St, Houston, TX", lat: 29.7604, lng: -95.3698, city: "Houston", state: "TX" },
];

const serviceTemplates = {
  "Cleaning": [
    { name: "Deep Home Cleaning", description: "Complete deep cleaning of your home including obscure areas.", price: 150, duration: 240, image: "https://images.unsplash.com/photo-1581578731117-104f2a41272c?q=80&w=600&auto=format&fit=crop" },
    { name: "Standard Maid Service", description: "Regular cleaning for maintenance.", price: 80, duration: 120, image: "https://images.unsplash.com/photo-1527515673510-813d3143c192?q=80&w=600&auto=format&fit=crop" },
    { name: "Sofa Vacuuming", description: "Detailed vacuuming to remove dust and allergens from sofas.", price: 45, duration: 60, image: "https://images.unsplash.com/photo-1556911220-e15b29be8c8f?q=80&w=600&auto=format&fit=crop" }
  ],
  "Plumbing": [
    { name: "Leak Repair", description: "Fixing leaking pipes and faucets.", price: 60, duration: 60, image: "https://images.unsplash.com/photo-1607472586893-edb57bdc0e39?q=80&w=600&auto=format&fit=crop" },
    { name: "Drain Cleaning", description: "Unclogging severe drain blockages.", price: 100, duration: 90, image: "https://images.unsplash.com/photo-1585704032915-c3400ca199e7?q=80&w=600&auto=format&fit=crop" }
  ],
  "Electrical": [
    { name: "Switch & Socket Installation", description: "Safely install or repair electrical switches.", price: 40, duration: 45, image: "https://images.unsplash.com/photo-1621905251189-08b45d6a269e?q=80&w=600&auto=format&fit=crop" },
    { name: "Fan Installation", description: "Ceiling or wall fan installation service.", price: 50, duration: 60, image: "https://images.unsplash.com/photo-1558402529-d56386620233?q=80&w=600&auto=format&fit=crop" }
  ],
  "Beauty": [
    { name: "Men's Haircut", description: "Expert styling and grooming.", price: 25, duration: 30, image: "https://images.unsplash.com/photo-1599351431202-1e0f0137899a?q=80&w=600&auto=format&fit=crop" },
    { name: "Manicure & Pedicure", description: "Relaxing nail care treatment.", price: 55, duration: 90, image: "https://images.unsplash.com/photo-1604654894610-df63bc536371?q=80&w=600&auto=format&fit=crop" }
  ]
};

const vendorNames = ["Reliable Hands", "City Fixers", "Urban Cleaners", "Elite services", "QuickRepair Pro", "Luxe Beauty", "BuildIt Well", "Prime Movers"];
const firstNames = ["John", "Jane", "Alice", "Bob", "Charlie", "Diana", "Ethan", "Fiona", "George", "Hannah"];
const lastNames = ["Smith", "Doe", "Johnson", "Brown", "Williams", "Jones", "Garcia", "Miller", "Davis"];

// Real-ish images
const userAvatars = [
    "https://randomuser.me/api/portraits/men/1.jpg", "https://randomuser.me/api/portraits/women/2.jpg",
    "https://randomuser.me/api/portraits/men/3.jpg", "https://randomuser.me/api/portraits/women/4.jpg",
    "https://randomuser.me/api/portraits/men/5.jpg"
];
const vendorLogos = [
    "https://images.unsplash.com/photo-1599305445671-ac291c95aaa9?w=200&fit=crop", 
    "https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?w=200&fit=crop",
    "https://images.unsplash.com/photo-1556761175-5973dc0f32e7?w=200&fit=crop"
];
const vendorCovers = [
  "https://images.unsplash.com/photo-1556910103-1c02745a30bf?w=800&fit=crop",
  "https://images.unsplash.com/photo-1581578731117-104f2a41272c?w=800&fit=crop"
];

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
    console.log('🌱 Start seeding ...');

    // Cleanup existing data
    console.log('🧹 Cleaning old data...');
    const deleteOrder = [
        'Feedback', 'Notification', 'Message', 'Conversation', 'Review', 'Payment', 
        'Booking', 'Service', 'Inventory', 'Availability', 'Document', 'Promotion', 
        'VendorPayoutAccount', 'VendorProfile', 'UserProfile', 'User', 'PhoneOTP', 'EmailOTP'
    ];

    for (const model of deleteOrder) {
        try {
            if (prisma[model]) await prisma[model].deleteMany(); // Case-insensitive check might be needed if model names vary, but here exact match
            else if (prisma[model.toLowerCase()]) await prisma[model.toLowerCase()].deleteMany();
        } catch (e) {
            console.log(`Skipped cleanup for ${model}`);
        }
    }

    const hashedPassword = await bcrypt.hash('password123', 10);

    // --- Create Super Admin ---
    await prisma.user.create({
      data: {
        email: "admin@keplix.com",
        password: hashedPassword,
        role: "admin",
        is_active: true,
        userProfile: {
          create: {
            name: "Super Admin",
            phone: "9999999999",
            address: "Keplix HQ"
          }
        }
      }
    });
    console.log("✅ Super Admin created: admin@keplix.com");


    // --- Create Vendors ---
    console.log('🛠 Creating Vendors...');
    const vendors = [];
    const locationList = [...locations, ...locations]; // Duplicate for volume

    // 1. Create specific test vendor
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
                    email: "info@keplixservices.com",
                    address: "123 Tech Park, CA",
                    city: "San Francisco",
                    state: "CA",
                    operating_hours: "09:00 AM - 09:00 PM",
                    status: "approved",
                    onboarding_completed: true,
                    latitude: 37.7749,
                    longitude: -122.4194,
                    description: "Authorized service partner for Keplix.",
                    image: getRandomElement(vendorLogos),
                    cover_image: getRandomElement(vendorCovers)
                }
            }
        }
    });
    // Add services to test vendor
    for (const [cat, services] of Object.entries(serviceTemplates)) {
         for (const s of services) {
             if (Math.random() > 0.5) { // Randomly pick some services
                 await prisma.service.create({
                     data: {
                         vendorId: testVendor.id,
                         category: cat,
                         name: s.name,
                         description: s.description,
                         price: s.price,
                         duration: s.duration,
                         image_url: s.image,
                         is_active: true
                     }
                 });
             }
         }
    }
    vendors.push(testVendor);


    // 2. Create random vendors
    for (let i = 0; i < 20; i++) {
        const busName = getRandomElement(vendorNames) + " " + (i + 1);
        const loc = getRandomElement(locationList);
        const category = getRandomElement(Object.keys(serviceTemplates)); // Main specialty
        
        const vendor = await prisma.user.create({
            data: {
                email: `vendor${i+1}@example.com`,
                password: hashedPassword,
                role: 'vendor',
                is_active: true,
                vendorProfile: {
                    create: {
                        business_name: busName,
                        phone: `555-010${i}`,
                        email: `contact@vendor${i+1}.com`,
                        address: loc.address,
                        city: loc.city,
                        state: loc.state,
                        operating_hours: "08:00 AM - 06:00 PM",
                        status: "approved",
                        onboarding_completed: true,
                        latitude: loc.lat + (Math.random() * 0.01), // Slight jitter
                        longitude: loc.lng + (Math.random() * 0.01),
                        description: `Professional ${category} services in ${loc.city}.`,
                        image: getRandomElement(vendorLogos),
                        cover_image: getRandomElement(vendorCovers),
                        owner_name: getRandomElement(firstNames) + " " + getRandomElement(lastNames)
                    }
                }
            }
        });

        // Add services relevant to their category
        const templates = serviceTemplates[category];
        if (templates) {
            for (const t of templates) {
                await prisma.service.create({
                    data: {
                        vendorId: vendor.id,
                        name: t.name,
                        description: t.description,
                        price: t.price, // Random deviation
                        duration: t.duration,
                        category: category,
                        image_url: t.image,
                        is_active: true
                    }
                });
            }
        }
        vendors.push(vendor);
    }


    // --- Create Customers ---
    console.log('👤 Creating Customers...');
    const users = [];

    // Specific test user
    const testUser = await prisma.user.create({
        data: {
            email: "user@example.com",
            password: hashedPassword,
            role: 'user',
            is_active: true,
            userProfile: {
                create: {
                    name: "Test User",
                    phone: "1234567890",
                    address: "Some House, Some Street",
                    profile_picture: "https://randomuser.me/api/portraits/men/99.jpg"
                }
            }
        }
    });
    users.push(testUser);

    for (let i = 0; i < 15; i++) {
        const user = await prisma.user.create({
             data: {
                 email: `user${i+1}@example.com`,
                 password: hashedPassword,
                 role: 'user',
                 is_active: true,
                 userProfile: {
                     create: {
                         name: getRandomElement(firstNames) + " " + getRandomElement(lastNames),
                         phone: `555-020${i}`,
                         address: `${getRandomInt(10, 999)} Park Ave`,
                         profile_picture: getRandomElement(userAvatars)
                     }
                 }
             }
        });
        users.push(user);
    }


    // --- Create Bookings & Reviews ---
    console.log('📅 Creating Bookings & Reviews...');
    const statuses = ['pending', 'confirmed', 'completed', 'cancelled'];
    
    // Get all services
    const allServices = await prisma.service.findMany();

    for (const user of users) {
        // Each user makes 1-5 bookings
        const numBookings = getRandomInt(1, 5);
        for (let b = 0; b < numBookings; b++) {
            const service = getRandomElement(allServices);
            const status = getRandomElement(statuses);
            
            // Random date in past or future
            const bookingDate = status === 'completed' 
                ? getRandomDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), new Date()) 
                : getRandomDate(new Date(), new Date(Date.now() + 14 * 24 * 60 * 60 * 1000));

            // Create Booking
            const booking = await prisma.booking.create({
                data: {
                    userId: user.id,
                    serviceId: service.id,
                    booking_date: bookingDate,
                    booking_time: "10:00 AM",
                    status: status,
                    notes: "Please arrive on time."
                }
            });

            // If non-pending/cancelled, maybe create a payment record
            if (['confirmed', 'completed'].includes(status)) {
                await prisma.payment.create({
                    data: {
                        bookingId: booking.id,
                        amount: service.price,
                        status: status === 'completed' ? 'success' : 'pending',
                        method: 'stripe',
                        transactionId: `txn_${getRandomInt(10000, 99999)}`
                    }
                });
            }

            // If completed, add a review
            if (status === 'completed' && Math.random() > 0.3) {
                 await prisma.review.create({
                     data: {
                         bookingId: booking.id,
                         userId: user.id,
                         rating: getRandomInt(3, 5),
                         comment: getRandomElement(["Great service!", "Very professional.", "Would recommend.", "Good, but late.", "Excellent work!"]),
                         createdAt: getRandomDate(bookingDate, new Date())
                     }
                 });
            }
            
            // If active/recent, maybe create a conversation
            if (status !== 'cancelled' && Math.random() > 0.7) {
                const conv = await prisma.conversation.create({
                    data: {
                        bookingId: booking.id
                    }
                });
                
                await prisma.message.create({
                    data: {
                        conversationId: conv.id,
                        senderId: user.id,
                        message_text: "Hi, is this slot confirmed?",
                        senderType: "user"
                    }
                });
                
                await prisma.message.create({
                     data: {
                         conversationId: conv.id,
                         senderId: service.vendorId,
                         message_text: "Yes, we will be there.",
                         senderType: "vendor"
                     }
                 });
            }
        }
    }

    console.log('✅ Seeding finished.');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
