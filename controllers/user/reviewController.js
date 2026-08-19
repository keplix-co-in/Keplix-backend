<<<<<<< HEAD
﻿import prisma from "../../util/prisma.js";


=======
import prisma from "../../util/prisma.js";
import { updateVendorRatingStats } from "../../util/ratingHelper.js";
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d

// @desc    Get Reviews
// @route   GET /interactions/api/reviews/
export const getReviews = async (req, res) => {
    try {
        const { vendor_id, user_id } = req.query;
<<<<<<< HEAD
=======
        // Coerce before arithmetic: these arrive as strings, and `(page-1)*limit`
        // on strings silently produced the wrong offset for anything but page 1.
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
        const skip = (page - 1) * limit;
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        let where = {};

        if (user_id) {
            where.userId = parseInt(user_id);
        } else if (vendor_id) {
<<<<<<< HEAD
            where.booking = {
                service: { vendorId: parseInt(vendor_id) },
            };
=======
            where.vendorId = parseInt(vendor_id);
        } else {
            // Without a scope this matched every review on the platform and
            // paged through the whole table. Callers must say whose reviews
            // they want.
            return res.status(400).json({
                success: false,
                message: 'Either user_id or vendor_id is required.',
                code: 'SCOPE_REQUIRED',
            });
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
        }

        const total = await prisma.review.count({ where });
        const reviews = await prisma.review.findMany({
            where,
<<<<<<< HEAD
=======
            skip: Number(skip),
            take: Number(limit),
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
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
<<<<<<< HEAD
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
=======
        });

        const absolute = (p) => (!p ? null : p.startsWith('http') ? p : `${baseUrl}${p}`);

        // Flat, client-facing aliases. The nested booking->service->vendor tree
        // below is what the customer app (user_keplix ReviewList/Profile) reads,
        // so it stays exactly as it was; these are added alongside it rather
        // than replacing it, so both shapes are valid at once.
        const flatten = (review) => ({
            customer: {
                id: review.user?.id ?? null,
                name: review.user?.userProfile?.name || null,
                image: absolute(review.user?.userProfile?.profile_picture),
            },
            service: {
                id: review.booking?.service?.id ?? null,
                name: review.booking?.service?.name || null,
            },
            date: review.booking?.booking_date ?? review.createdAt ?? null,
        });

        // Prefix relative media paths with the server base URL
        const formatted = reviews.map((review) => {
            const vp = review.booking?.service?.vendor?.vendorProfile;
            if (!vp) return { ...review, ...flatten(review) };
            return {
                ...review,
                ...flatten(review),
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

        res.json({
            success: true,
            data: formatted,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                totalPages: Math.ceil(total / limit)
            }
        });
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
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
<<<<<<< HEAD
    const { bookingId, rating, comment } = req.body;
=======
    const { bookingId, rating: rawRating, comment } = req.body;
    // Review.rating is an Int column. parseFloat alone let a 4.5 through to
    // Prisma, which rejects it outright — the review just failed to save.
    const rating = Math.round(parseFloat(rawRating));
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d

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

<<<<<<< HEAD
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
=======
    const vendorId = booking.service?.vendorId;

    // 3. Create review and update vendor stats in a transaction
    const review = await prisma.$transaction(async (tx) => {
      const createdReview = await tx.review.create({
        data: {
          bookingId: parseInt(bookingId),
          userId,
          vendorId,
          rating,
          comment: comment || null,
        },
      });

      if (vendorId) {
        await updateVendorRatingStats(tx, vendorId);
      }

      return createdReview;
    });
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d

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

<<<<<<< HEAD
    const review = await prisma.review.findUnique({ where: { id: reviewId } });
=======
    const review = await prisma.review.findUnique({
      where: { id: reviewId },
    });

>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
    if (!review) {
      return res.status(404).json({ success: false, message: 'Review not found.' });
    }
    if (review.userId !== userId) {
      return res.status(403).json({ success: false, message: 'Not authorised to delete this review.' });
    }

<<<<<<< HEAD
    await prisma.review.delete({ where: { id: reviewId } });
=======
    const vendorId = review.vendorId;

    await prisma.$transaction(async (tx) => {
      await tx.review.delete({ where: { id: reviewId } });

      if (vendorId) {
        await updateVendorRatingStats(tx, vendorId);
      }
    });

>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
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
<<<<<<< HEAD

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
=======
    const { page = 1, limit = 20 } = req.query;
    const skip = (page - 1) * limit;
    const where = { vendorId: parseInt(vendorId) };

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        skip: Number(skip),
        take: Number(limit),
        include: {
          user: {
            select: {
              id: true,
              userProfile: { select: { name: true, profile_picture: true } }
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.review.count({ where })
    ]);

    res.json({
      success: true,
      count: reviews.length,
      data: reviews,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / limit)
      }
    });
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
<<<<<<< HEAD


=======
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
