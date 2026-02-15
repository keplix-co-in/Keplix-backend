import prisma from "../util/prisma.js";



// @desc    Get Promotions
// @route   GET /interactions/api/promotions/vendor/:vendorId
export const getPromotions = async (req, res) => {
  try {
    const promotions = await prisma.promotion.findMany({
      where: { vendorId: parseInt(req.params.vendorId) },
    });
    res.json(promotions);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

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
        end_date: new Date(end_date),
      },
    });
    res.status(201).json(promotion);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc  Update Promotion
export const updatePromotion = async (req, res) => {
  const promoId = parseInt(req.params.promoId);
  const vendorId = req.user.id;

  try {
    // Validate promoId
    if (isNaN(promoId)) {
      return res.status(400).json({ message: "Invalid promotion ID" });
    }

    // Empty body check
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({ message: "No data provided to update" });
    }

    const { title, description, discount, start_date, end_date } = req.body;

    // Empty body check
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({ message: "No data provided to update" });
    }

    // Check promotion exists & belongs to vendor
    const existingPromotion = await prisma.promotion.findFirst({
      where: {
        id: promoId,
        vendorId: vendorId,
      },
    });

    if (!existingPromotion) {
      return res.status(404).json({
        message: "Promotion not found or not authorized",
      });
    }

    // Business validation
    if (discount !== undefined && parseFloat(discount) <= 0) {
      return res.status(400).json({
        message: "Discount must be greater than 0",
      });
    }

    if (start_date && end_date && new Date(start_date) >= new Date(end_date)) {
      return res.status(400).json({
        message: "Start date must be before end date",
      });
    }

    // Update promotion
    const updatedPromotion = await prisma.promotion.update({
      where: { id: promoId },
      data: {
        title,
        description,
        discount: discount !== undefined ? parseFloat(discount) : undefined,
        start_date: start_date ? new Date(start_date) : undefined,
        end_date: end_date ? new Date(end_date) : undefined,
      },
    });

    res.status(200).json({
      message: "Promotion updated successfully",
      promotion: updatedPromotion,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Delete Promotion
export const deletePromotion = async (req, res) => {
  const promoId = parseInt(req.params.promoId);
  const vendorId = req.user.id;

  try {
    // Validate promoId
    if (isNaN(promoId)) {
      return res.status(400).json({ message: "Invalid promotion ID" });
    }

    // Check promotion exists & belongs to vendor
    const existingPromotion = await prisma.promotion.findFirst({
      where: {
        id: promoId,
        vendorId: vendorId,
      },
    });

    if (!existingPromotion) {
      return res.status(404).json({
        message: "Promotion not found or not authorized",
      });
    }

    // Delete promotion
    await prisma.promotion.delete({
      where: { id: promoId },
    });

    // Success response
    res.status(200).json({
      message: "Promotion deleted successfully",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

