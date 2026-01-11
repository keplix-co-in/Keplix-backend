import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// @desc    Submit Feedback to Platform (as Vendor)
// @route   POST /interactions/api/vendor/feedback/create/
export const createVendorFeedback = async (req, res) => {
    const { title, message, category } = req.body;
    try {
        const feedback = await prisma.feedback.create({
            data: {
                userId: req.user.id,
                title,
                message,
                category: category || 'general'
            }
        });
        res.status(201).json(feedback);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

// @desc    Get My Feedback (Vendor)
// @route   GET /interactions/api/vendor/feedback/
export const getVendorFeedback = async (req, res) => {
    try {
        const feedback = await prisma.feedback.findMany({
            where: { userId: req.user.id }
        });
        res.json(feedback);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}
