import prisma from "../../util/prisma.js";



// @desc    Submit Feedback
// @route   POST /interactions/api/feedback/create/
export const createFeedback = async (req, res) => {
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

// @desc    Get Feedback (Admin/User)
export const getFeedback = async (req, res) => {
    // Return user's feedback
    try {
        const { page = 1, limit = 20 } = req.query;
        const skip = (page - 1) * limit;
        const where = { userId: req.user.id };

        const [feedback, total] = await Promise.all([
            prisma.feedback.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: Number(skip),
                take: Number(limit)
            }),
            prisma.feedback.count({ where })
        ]);

        res.json({
            data: feedback,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}


