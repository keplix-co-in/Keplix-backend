import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// @desc    Get Reviews
// @route   GET /interactions/api/reviews/
export const getReviews = async (req, res) => {
    try {
        const reviews = await prisma.review.findMany({
            include: { user: { include: { userProfile: true } } }
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
