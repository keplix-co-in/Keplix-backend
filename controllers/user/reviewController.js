import prisma from '../util/prisma.js';



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

// @desc    Create a review for a vendor
// @route   POST /interactions/api/reviews
// @access  Private (User)
export const createReview = async (req, res) => {
  try {
    const userId = req.user.id;
    const { vendorId, rating, comment } = req.body; // Expecting vendorId (VendorProfile ID), not User ID

    // 1. Check if user has a COMPLETED booking with this vendor
    // This prevents fake reviews from people who haven't used the service
    const hasBooking = await prisma.booking.findFirst({
      where: {
        userId: userId,
        vendorId: parseInt(vendorId),
        status: 'completed', // CRITICAL CHECK
      },
    });

    if (!hasBooking) {
      return res.status(403).json({
        success: false,
        message: 'You can only review vendors after a completed service.',
        code: 'NO_BOOKING_FOUND'
      });
    }

    // 2. Check if already reviewed (Optional: allow 1 review per booking?)
    // For now, let's limit 1 review per User-Vendor pair to keep it simple,
    // or remove this block if you want to allow multiple reviews.
    const existingReview = await prisma.review.findFirst({
      where: {
        userId: userId,
        vendorId: parseInt(vendorId),
      },
    });

    if (existingReview) {
      return res.status(400).json({
        success: false,
        message: 'You have already reviewed this vendor.',
        code: 'DUPLICATE_REVIEW'
      });
    }

    // 3. Create the Review
    const review = await prisma.review.create({
      data: {
        userId,
        vendorId: parseInt(vendorId),
        rating: parseFloat(rating),
        comment,
      },
    });

    // 4. FIX: Recalculate Vendor Average Rating
    const aggregates = await prisma.review.aggregate({
      where: { vendorId: parseInt(vendorId) },
      _avg: { rating: true },
      _count: { rating: true },
    });

    // Update Vendor Profile with new stats
    await prisma.vendorProfile.update({
      where: { id: parseInt(vendorId) },
      data: {
        rating: aggregates._avg.rating || 0.0,
        numReviews: aggregates._count.rating || 0,
      },
    });

    res.status(201).json({ 
      success: true, 
      data: review,
      message: 'Review added and vendor rating updated.' 
    });

  } catch (error) {
    console.error('Create Review Error:', error);
    res.status(500).json({ success: false, message: 'Server Error', error: error.message });
  }
};

// @desc    Get reviews for a specific vendor
// @route   GET /interactions/api/reviews/:vendorId
export const getVendorReviews = async (req, res) => {
  try {
    const { vendorId } = req.params;

    const reviews = await prisma.review.findMany({
      where: { vendorId: parseInt(vendorId) },
      include: {
        user: {
          select: { id: true, name: true, profileImage: true } // Fetch reviewer details
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ success: true, count: reviews.length, data: reviews });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

