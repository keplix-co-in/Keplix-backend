import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// Fixed Service Categories - matching frontend constants
const FIXED_CATEGORIES = [
  "Car Service & Repairs",
  "Car Cleaning",
  "Dents & Painting",
  "Interior Services",
  "Tyre & Wheel Services",
  "Battery Services",
  "AC Service & Repair",
  "Windshield Services",
  "Car Inspection",
  "Insurance & Registration",
  "Breakdown Assistance",
  "Custom & Modifications"
];

const locations = [
  { address: "B1-41, Chandan Park, Dwarka Mor - 110059", lat: 28.6139, lng: 77.2090, city: "Delhi", state: "DL" },
  { address: "Sector 18, Noida - 201301", lat: 28.5355, lng: 77.3910, city: "Noida", state: "UP" },
  { address: "MG Road, Gurugram - 122002", lat: 28.4595, lng: 77.0266, city: "Gurugram", state: "HR" },
  { address: "Connaught Place, New Delhi - 110001", lat: 28.6328, lng: 77.2197, city: "New Delhi", state: "DL" },
];

const serviceTemplates = {
  "Car Service & Repairs": [
    { name: "Engine Repairs", description: "Complete engine diagnostics and repair services", price: 9499, duration: 2880, image: "https://images.unsplash.com/photo-1486262715619-67b85e0b08d3?q=80&w=600&auto=format&fit=crop" },
    { name: "Brake Service", description: "Professional brake inspection and repair", price: 3499, duration: 270, image: "https://images.unsplash.com/photo-1625047509168-a7026f36de04?q=80&w=600&auto=format&fit=crop" },
    { name: "Transmission Repair", description: "Expert transmission service and repair", price: 12999, duration: 4320, image: "https://images.unsplash.com/photo-1615906655593-ad0386982a0f?q=80&w=600&auto=format&fit=crop" },
    { name: "Suspension Service", description: "Complete suspension system check and repair", price: 5499, duration: 1440, image: "https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?q=80&w=600&auto=format&fit=crop" }
  ],
  "Car Cleaning": [
    { name: "Deep Cleaning", description: "Complete interior and exterior deep cleaning", price: 1500, duration: 210, image: "https://images.unsplash.com/photo-1607860108855-64acf2078ed9?q=80&w=600&auto=format&fit=crop" },
    { name: "Premium Wash", description: "High-quality wash with wax coating", price: 899, duration: 90, image: "https://images.unsplash.com/photo-1601362840469-51e4d8d58785?q=80&w=600&auto=format&fit=crop" },
    { name: "Interior Detailing", description: "Professional interior cleaning and conditioning", price: 2499, duration: 150, image: "https://images.unsplash.com/photo-1520340356584-f9917d1eea6f?q=80&w=600&auto=format&fit=crop" }
  ],
  "Dents & Painting": [
    { name: "Dent Removal", description: "Professional dent removal without painting", price: 3999, duration: 1440, image: "https://images.unsplash.com/photo-1625047509168-a7026f36de04?q=80&w=600&auto=format&fit=crop" },
    { name: "Full Body Paint", description: "Complete car repainting with quality finish", price: 25000, duration: 8640, image: "https://images.unsplash.com/photo-1615906655593-ad0386982a0f?q=80&w=600&auto=format&fit=crop" },
    { name: "Touch Up Paint", description: "Minor scratches and touch-up painting", price: 1999, duration: 1440, image: "https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?q=80&w=600&auto=format&fit=crop" }
  ],
  "Interior Services": [
    { name: "Seat Cover Installation", description: "Premium seat cover fitting service", price: 4999, duration: 150, image: "https://images.unsplash.com/photo-1449130015084-2fa092a8b8b0?q=80&w=600&auto=format&fit=crop" },
    { name: "Dashboard Polish", description: "Dashboard cleaning and polishing", price: 799, duration: 60, image: "https://images.unsplash.com/photo-1511919884226-fd3cad34687c?q=80&w=600&auto=format&fit=crop" },
    { name: "Carpet Cleaning", description: "Deep cleaning of car carpets and mats", price: 1299, duration: 90, image: "https://images.unsplash.com/photo-1520340356584-f9917d1eea6f?q=80&w=600&auto=format&fit=crop" }
  ],
  "Tyre & Wheel Services": [
    { name: "Tyre Replacement", description: "New tyre installation with balancing", price: 8999, duration: 90, image: "https://images.unsplash.com/photo-1592840496694-26d035b52b48?q=80&w=600&auto=format&fit=crop" },
    { name: "Wheel Alignment", description: "Professional wheel alignment service", price: 1499, duration: 60, image: "https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?q=80&w=600&auto=format&fit=crop" },
    { name: "Wheel Balancing", description: "Precision wheel balancing", price: 999, duration: 30, image: "https://images.unsplash.com/photo-1486262715619-67b85e0b08d3?q=80&w=600&auto=format&fit=crop" }
  ],
  "Battery Services": [
    { name: "Battery Replacement", description: "New battery installation with warranty", price: 4999, duration: 30, image: "https://images.unsplash.com/photo-1593941707882-a5bba14938c7?q=80&w=600&auto=format&fit=crop" },
    { name: "Battery Check-up", description: "Complete battery health diagnosis", price: 299, duration: 15, image: "https://images.unsplash.com/photo-1615906655593-ad0386982a0f?q=80&w=600&auto=format&fit=crop" }
  ],
  "AC Service & Repair": [
    { name: "AC Gas Refill", description: "AC gas refilling service", price: 2499, duration: 60, image: "https://images.unsplash.com/photo-1581092160562-40aa08e78837?q=80&w=600&auto=format&fit=crop" },
    { name: "AC Repair", description: "Complete AC system repair", price: 4999, duration: 150, image: "https://images.unsplash.com/photo-1621905251189-08b45d6a269e?q=80&w=600&auto=format&fit=crop" },
    { name: "AC Filter Cleaning", description: "Thorough AC filter cleaning", price: 799, duration: 30, image: "https://images.unsplash.com/photo-1625047509168-a7026f36de04?q=80&w=600&auto=format&fit=crop" }
  ],
  "Windshield Services": [
    { name: "Windshield Replacement", description: "Complete windshield replacement", price: 8999, duration: 150, image: "https://images.unsplash.com/photo-1449130015084-2fa092a8b8b0?q=80&w=600&auto=format&fit=crop" },
    { name: "Crack Repair", description: "Windshield crack fixing", price: 1999, duration: 60, image: "https://images.unsplash.com/photo-1511919884226-fd3cad34687c?q=80&w=600&auto=format&fit=crop" }
  ]
};

const vendorNames = ["Dwarka Mor Service", "Auto Care Center", "Premium Car Service", "Elite Motors", "QuickFix Auto", "Luxury Car Care", "Speed Auto Repair", "City Car Service"];
const firstNames = ["Rajesh", "Amit", "Priya", "Suresh", "Vikram", "Neha", "Rohit", "Anjali", "Karan", "Pooja"];
const lastNames = ["Kumar", "Singh", "Sharma", "Patel", "Verma", "Gupta", "Reddy", "Shah", "Mehta", "Jain"];

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
            if (prisma[model]) await prisma[model].deleteMany(); 
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
          create: { name: "Super Admin", phone: "9999999999", address: "Keplix HQ" }
        }
      }
    });

    // ==========================================
    // 1. Create Target Vendor: vendor1 (High Data)
    // ==========================================
    console.log('🛠 Creating Vendor1...');
    const vendor1 = await prisma.user.create({
        data: {
            email: "vendor1@example.com",
            password: hashedPassword,
            role: 'vendor',
            is_active: true,
            vendorProfile: {
                create: {
                    business_name: "Vendor 1 Premier Auto",
                    phone: "9876543210",
                    email: "contact@vendor1.com",
                    address: "Block A, Cyber Hub",
                    city: "Gurugram",
                    state: "HR",
                    operating_hours: "08:00 AM - 10:00 PM",
                    status: "approved",
                    onboarding_completed: true,
                    latitude: 28.4595,
                    longitude: 77.0266,
                    description: "Premium auto care services with top-notch equipment.",
                    image: getRandomElement(vendorLogos),
                    cover_image: getRandomElement(vendorCovers),
                    owner_name: "Vendor One Owner"
                }
            }
        }
    });

    // Add comprehensive services to vendor1 (All categories)
    const vendor1Services = [];
    for (const [cat, services] of Object.entries(serviceTemplates)) {
         for (const s of services) {
             const service = await prisma.service.create({
                 data: {
                     vendorId: vendor1.id,
                     category: cat,
                     name: s.name,
                     description: s.description,
                     price: s.price,
                     duration: s.duration,
                     image_url: s.image,
                     is_active: true,
                     is_featured: Math.random() > 0.7 
                 }
             });
             vendor1Services.push(service);
         }
    }
    
    // ==========================================
    // 2. Create Target User: user1 (High Data)
    // ==========================================
    console.log('👤 Creating User1...');
    const user1 = await prisma.user.create({
        data: {
            email: "user1@example.com",
            password: hashedPassword,
            role: 'user',
            is_active: true,
            userProfile: {
                create: {
                    name: "User One",
                    phone: "9810012345",
                    address: "User 1 Residence, Delhi",
                    profile_picture: "https://randomuser.me/api/portraits/men/1.jpg"
                }
            }
        }
    });

    // ==========================================
    // 3. Generate Bulk Bookings for User1 -> Vendor1
    // ==========================================
    console.log('📅 Generating Bulk Data for User1 & Vendor1...');

    const createBooking = async (status, vendorStatus, dateOffsetDays, isPast = false) => {
        const service = getRandomElement(vendor1Services);
        const bookingDate = new Date(Date.now() + dateOffsetDays * 24 * 60 * 60 * 1000);
        const createdAt = isPast ? new Date(bookingDate.getTime() - 2 * 24 * 60 * 60 * 1000) : new Date();

        const booking = await prisma.booking.create({
            data: {
                userId: user1.id,
                serviceId: service.id,
                booking_date: bookingDate,
                booking_time: `${getRandomInt(9, 17)}:00`,
                status: status,
                vendor_status: vendorStatus,
                notes: "Test booking for data population",
                createdAt: createdAt,
                updatedAt: createdAt
            }
        });

        // Add Payment if accepted
        if (vendorStatus === 'accepted') {
            await prisma.payment.create({
                data: {
                    bookingId: booking.id,
                    amount: Math.round(service.price * 1.18),
                    status: (status === 'completed' || status === 'user_confirmed') ? 'success' : 'pending',
                    method: 'upi',
                    transactionId: `txn_${Date.now()}_${Math.random().toString(36).substring(7)}`,
                    createdAt: createdAt
                }
            });
        }

        // Add Review if completed
        if (['completed', 'user_confirmed'].includes(status)) {
            await prisma.review.create({
                data: {
                    bookingId: booking.id,
                    userId: user1.id,
                    rating: getRandomInt(4, 5),
                    comment: getRandomElement([
                        "Fantastic experience with Vendor 1!",
                        "Professional and quick.",
                        "Best service in town.",
                        "Highly recommended."
                    ]),
                    createdAt: new Date(bookingDate.getTime() + 24 * 60 * 60 * 1000)
                }
            });
        }
    };

    // -> 10 Requests (Pending/Rejected) - Tab 1
    for (let i = 0; i < 6; i++) await createBooking('pending', 'pending', getRandomInt(1, 10));
    for (let i = 0; i < 4; i++) await createBooking('pending', 'rejected', getRandomInt(1, 10)); // Rejected requests

    // -> 10 Upcoming (Accepted & Confirmed/Scheduled) - Tab 2
    for (let i = 0; i < 10; i++) await createBooking('confirmed', 'accepted', getRandomInt(1, 30));

    // -> 10 Completed (Accepted & Completed) - Tab 3 (Also populates Earnings)
    for (let i = 0; i < 10; i++) await createBooking('completed', 'accepted', getRandomInt(-30, -1), true);


    // ==========================================
    // 4. Background Noise (Generic Data)
    // ==========================================
    console.log('...Adding background noise...');
    // Create one more random vendor and user just to show list diversity
    const otherUser = await prisma.user.create({
        data: {
            email: "other@user.com",
            password: hashedPassword,
            role: 'user',
            is_active: true,
            userProfile: { create: { name: "Other User", phone: "9998887776", address: "Other Place" } }
        }
    });

    // ...existing code...
    
    console.log('✅ Seeding finished!');
    console.log('Credentials:');
    console.log('User: user1@example.com / password123');
    console.log('Vendor: vendor1@example.com / password123');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
