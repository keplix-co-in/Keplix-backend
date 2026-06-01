import prisma from "../../util/prisma.js";



// @desc    Get Reviews
// @route   GET /interactions/api/reviews/
export const getReviews = async (req, res) => {
    try {
        const { vendor_id, user_id } = req.query;
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        let where = {};

        if (user_id) {
            where.userId = parseInt(user_id);
        } else if (vendor_id) {
            where.booking = {
                service: { vendorId: parseInt(vendor_id) },
            };
        }

        const reviews = await prisma.review.findMany({
            where,
            include: {
                user: {
                    select: {
                        id: true,
                        userProfile: { select: { name: true, profile_picture: true } },
                    },
                },
                booking: {
                    include: {
                        service: {
                            include: {
                                vendor: {
                                    select: {
                                        id: true,
                                        vendorProfile: {
                                            select: {
                                                business_name: true,
                                                image: true,
                                                cover_image: true,
                                                address: true,
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
        });

        // Prefix relative media paths with the server base URL
        const formatted = reviews.map((review) => {
            const vp = review.booking?.service?.vendor?.vendorProfile;
            if (!vp) return review;
            return {
                ...review,
                booking: {
                    ...review.booking,
                    service: {
                        ...review.booking.service,
                        image_url: review.booking.service.image_url?.startsWith('http')
                            ? review.booking.service.image_url
                            : review.booking.service.image_url
                                ? `${baseUrl}${review.booking.service.image_url}`
                                : null,
                        vendor: {
                            ...review.booking.service.vendor,
                            vendorProfile: {
                                ...vp,
                                cover_image: vp.cover_image?.startsWith('http')
                                    ? vp.cover_image
                                    : vp.cover_image
                                        ? `${baseUrl}${vp.cover_image}`
                                        : null,
                                image: vp.image?.startsWith('http')
                                    ? vp.image
                                    : vp.image
                                        ? `${baseUrl}${vp.image}`
                                        : null,
                            },
                        },
                    },
                },
            };
        });

        res.json({ success: true, data: formatted });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

// @desc    Create a review for a booking
// @route   POST /interactions/api/reviews/create
// @access  Private (User)
export const createReview = async (req, res) => {
  try {
    const userId = req.user.id;
    const { bookingId, rating, comment } = req.body;

    // 1. Load the booking and verify it belongs to this user and is completed
    const booking = await prisma.booking.findFirst({
      where: {
        id: parseInt(bookingId),
        userId: userId,
        status: { in: ['service_completed', 'user_confirmed', 'completed'] },
      },
      include: { service: true },
    });

    if (!booking) {
      return res.status(403).json({
        success: false,
        message: 'You can only review after the service has been completed.',
        code: 'NO_BOOKING_FOUND',
      });
    }

    // 2. Prevent duplicate reviews for the same booking
    const existingReview = await prisma.review.findUnique({
      where: { bookingId: parseInt(bookingId) },
    });

    if (existingReview) {
      return res.status(400).json({
        success: false,
        message: 'You have already submitted a review for this booking.',
        code: 'DUPLICATE_REVIEW',
      });
    }

    // 3. Create the review
    const review = await prisma.review.create({
      data: {
        bookingId: parseInt(bookingId),
        userId,
        rating: parseFloat(rating),
        comment: comment || null,
      },
    });

    // 4. Recalculate vendor average rating via VendorProfile
    const vendorId = booking.service?.vendorId;
    if (vendorId) {
      const vendorBookingIds = await prisma.booking.findMany({
        where: { service: { vendorId } },
        select: { id: true },
      });
      const ids = vendorBookingIds.map((b) => b.id);
      const aggregates = await prisma.review.aggregate({
        where: { bookingId: { in: ids } },
        _avg: { rating: true },
        _count: { rating: true },
      });
      await prisma.vendorProfile.updateMany({
        where: { userId: vendorId },
        data: {
          rating: aggregates._avg.rating || 0.0,
          numReviews: aggregates._count.rating || 0,
        },
      });
    }

    res.status(201).json({
      success: true,
      data: review,
      message: 'Review submitted successfully.',
    });
  } catch (error) {
    console.error('Create Review Error:', error);
    res.status(500).json({ success: false, message: 'Server Error', error: error.message });
  }
};

// @desc    Delete a review
// @route   DELETE /interactions/api/reviews/:id
// @access  Private (User — own reviews only)
export const deleteReview = async (req, res) => {
  try {
    const userId = req.user.id;
    const reviewId = parseInt(req.params.id);

    const review = await prisma.review.findUnique({ where: { id: reviewId } });
    if (!review) {
      return res.status(404).json({ success: false, message: 'Review not found.' });
    }
    if (review.userId !== userId) {
      return res.status(403).json({ success: false, message: 'Not authorised to delete this review.' });
    }

    await prisma.review.delete({ where: { id: reviewId } });
    res.json({ success: true, message: 'Review deleted.' });
  } catch (error) {
    console.error('Delete Review Error:', error);
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


