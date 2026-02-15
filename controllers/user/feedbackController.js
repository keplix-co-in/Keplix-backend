import prisma from 'file:///C:/keplix-frontend-master/keplix-backend/util/prisma.js';



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
        const feedback = await prisma.feedback.findMany({
            where: { userId: req.user.id }
        });
        res.json(feedback);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}


