import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// @desc    Get Reviews
// @route   GET /interactions/api/reviews/
export const getReviews = async (req, res) => {
    try {
        const { vendor_id } = req.query;
        let where = {};
        
        if (vendor_id) {
            // Filter reviews where the booking's service belongs to this vendor
            // Note: Reviews are linked to Booking. Booking has Service. Service has vendorId.
            // But Prisma schema Review -> Booking -> Service ?? 
            // Let's check schema.
            // If Review is directly linked to Vendor, or via Booking.
            // Assuming Review -> Booking. And Booking -> Service -> User(Vendor)
             where = {
                booking: {
                    service: {
                         vendorId: parseInt(vendor_id)
                    }
                }
            };
        }

        const reviews = await prisma.review.findMany({
            where,
            include: { 
                user: { include: { userProfile: true } }, // The reviewer (customer)
                booking: { include: { service: true } }   // The service context
            },
            orderBy: { createdAt: 'desc' }
        });
        res.json(reviews);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

// @desc    Create Review
// @route   POST /interactions/api/reviews/create/
export const createReview = async (req, res) => {
    const { booking_id, rating, comment } = req.body;
    try {
        const review = await prisma.review.create({
            data: {
                userId: req.user.id,
                bookingId: parseInt(booking_id),
                rating: parseInt(rating),
                comment
            }
        });
        res.status(201).json(review);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}
