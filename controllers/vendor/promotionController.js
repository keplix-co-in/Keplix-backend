import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// @desc    Get Promotions
// @route   GET /interactions/api/promotions/vendor/:vendorId
export const getPromotions = async (req, res) => {
    try {
        const promotions = await prisma.promotion.findMany({
            where: { vendorId: parseInt(req.params.vendorId) }
        });
        res.json(promotions);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

// @desc    Create Promotion
// @route   POST /interactions/api/promotions/create/
export const createPromotion = async (req, res) => {
    const { title, description, discount, start_date, end_date } = req.body;
    try {
        const promotion = await prisma.promotion.create({
            data: {
                vendorId: req.user.id,
                title,
                description,
                discount: parseFloat(discount),
                start_date: new Date(start_date),
                end_date: new Date(end_date)
            }
        });
        res.status(201).json(promotion);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

// @desc    Update Promotion
export const updatePromotion = async (req, res) => {
    // ...
    res.json({ message: "Update stub" });
}

// @desc    Delete Promotion
export const deletePromotion = async (req, res) => {
    // ...
    res.json({ message: "Delete stub" });
}
