import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// @desc    Get reviews for this vendor's services
// @route   GET /interactions/api/vendor/reviews/
export const getVendorReviews = async (req, res) => {
    try {
        const vendorId = req.user.id; // From authMiddleware

        const reviews = await prisma.review.findMany({
            where: {
                booking: {
                    service: {
                        vendorId: vendorId
                    }
                }
            },
            include: { 
                user: { include: { userProfile: true } }, // The reviewer details
                booking: { 
                    select: {
                        id: true,
                        booking_date: true,
                        service: {
                            select: {
                                name: true
                            }
                        }
                    } 
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        res.json(reviews);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Reply to a review (Future implementation)
// @route   POST /interactions/api/vendor/reviews/:id/reply
export const replyToReview = async (req, res) => {
    // Placeholder for reply logic
    res.status(501).json({ message: "Not Implemented Yet" });
};
