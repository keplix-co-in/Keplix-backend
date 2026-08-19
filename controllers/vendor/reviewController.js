<<<<<<< HEAD
﻿import prisma from "../../util/prisma.js";
=======
import prisma from "../../util/prisma.js";

/**
 * Shapes a Review row into the flat contract the vendor app renders directly.
 *
 * The vendor screen reads `customer.name` / `service.name` / `booking.date`.
 * Prisma returns `user.userProfile.name` / `booking.service.name` /
 * `booking.booking_date`, so without this mapping every card fell through to
 * its "Customer" / "Service" / "No date" placeholder — the data was fetched
 * correctly and then thrown away by a shape mismatch.
 */
const toVendorReview = (review, baseUrl) => {
    const absolute = (p) => (!p ? null : p.startsWith('http') ? p : `${baseUrl}${p}`);
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d

    return {
        id: review.id,
        rating: review.rating,
        comment: review.comment,
        reply: review.reply,
        repliedAt: review.repliedAt,
        createdAt: review.createdAt,
        customer: {
            id: review.user?.id ?? null,
            name: review.user?.userProfile?.name || null,
            image: absolute(review.user?.userProfile?.profile_picture),
        },
        service: {
            id: review.booking?.service?.id ?? null,
            name: review.booking?.service?.name || null,
        },
        booking: {
            id: review.booking?.id ?? null,
            date: review.booking?.booking_date ?? null,
        },
    };
};

// @desc    Get reviews for the logged-in vendor
// @route   GET /interactions/api/vendor/reviews
// @access  Private (Vendor)
export const getVendorReviews = async (req, res) => {
    try {
        // Scope comes from the token, never the query string. The vendor app
        // previously read this list through the public /interactions/api/reviews
        // endpoint with a client-supplied vendor_id, which let any authenticated
        // caller page through any other vendor's reviews.
        const vendorId = req.user.id;

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
        const skip = (page - 1) * limit;

        const { customer_id, service_id, date_from, date_to, min_rating } = req.query;

        // Filtered on Review.vendorId (indexed) rather than by walking
        // booking -> service -> vendorId, which could not use an index and
        // forced a join on every page. Legacy rows with a null vendorId are
        // backfilled by the accompanying migration.
        const where = { vendorId };

        if (customer_id) where.userId = parseInt(customer_id);
        if (min_rating) where.rating = { gte: parseInt(min_rating) };

        const bookingFilter = {};
        if (service_id) bookingFilter.serviceId = parseInt(service_id);

        // A bare `new Date('YYYY-MM-DD')` is midnight, so using it for the
        // upper bound excluded every booking on the end date itself. Push it
        // to the end of that day. Invalid dates are ignored rather than
        // producing an `Invalid Date` that matches nothing silently.
        const range = {};
        const from = date_from ? new Date(date_from) : null;
        const to = date_to ? new Date(date_to) : null;
        if (from && !Number.isNaN(from.getTime())) range.gte = from;
        if (to && !Number.isNaN(to.getTime())) {
            to.setHours(23, 59, 59, 999);
            range.lte = to;
        }
        if (Object.keys(range).length) bookingFilter.booking_date = range;

        if (Object.keys(bookingFilter).length) where.booking = bookingFilter;

        // `select`, not `include`. The previous version pulled every Booking
        // column plus the whole nested service -> vendor -> vendorProfile tree
        // for each row, to render five fields.
        const [reviews, total] = await Promise.all([
            prisma.review.findMany({
                where,
                skip,
                take: limit,
                select: {
                    id: true,
                    rating: true,
                    comment: true,
                    reply: true,
                    repliedAt: true,
                    createdAt: true,
                    user: {
                        select: {
                            id: true,
                            userProfile: { select: { name: true, profile_picture: true } },
                        },
                    },
                    booking: {
                        select: {
                            id: true,
                            booking_date: true,
                            service: { select: { id: true, name: true } },
                        },
                    },
                },
                orderBy: { createdAt: 'desc' },
            }),
            prisma.review.count({ where }),
        ]);

        const baseUrl = `${req.protocol}://${req.get('host')}`;

        const response = {
            success: true,
            data: reviews.map((r) => toVendorReview(r, baseUrl)),
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit) || 1,
                hasMore: skip + reviews.length < total,
            },
        };

        // Rating summary, derived from the reviews themselves rather than read
        // off VendorProfile.rating.
        //
        // That denormalised column is only written when a review is created or
        // deleted, so it reads 0 for every vendor whose reviews predate the
        // rating helper working — which is why this page showed no rating even
        // with reviews on screen. Aggregating here is authoritative and cannot
        // go stale. Deliberately scoped to `vendorId` only, NOT the active
        // filters: this is the vendor's overall rating, and it must not change
        // when the list below is filtered.
        if (page === 1) {
            const summaryStats = await prisma.review.aggregate({
                where: { vendorId },
                _avg: { rating: true },
                _count: { _all: true },
            });

            const count = summaryStats._count._all ?? 0;
            response.summary = {
                rating: count > 0 ? Number((summaryStats._avg.rating ?? 0).toFixed(1)) : 0,
                totalReviews: count,
            };
        }

        // Filter dropdown options, computed server-side and only on the first
        // page. Deriving them client-side from the loaded rows meant the
        // dropdowns only ever listed whoever happened to be on page 1.
        if (page === 1) {
            const [customerRows, services] = await Promise.all([
                prisma.review.findMany({
                    where: { vendorId },
                    distinct: ['userId'],
                    take: 200,
                    select: {
                        user: {
                            select: { id: true, userProfile: { select: { name: true } } },
                        },
                    },
                }),
                prisma.service.findMany({
                    where: { vendorId },
                    select: { id: true, name: true },
                    orderBy: { name: 'asc' },
                }),
            ]);

            response.filters = {
                customers: customerRows
                    .map((r) => ({
                        id: r.user?.id ?? null,
                        name: r.user?.userProfile?.name || null,
                    }))
                    .filter((c) => c.id && c.name),
                services,
            };
        }

        res.json(response);
    } catch (error) {
        console.error('Get Vendor Reviews Error:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

// @desc    Reply to a review
<<<<<<< HEAD
// @route   POST /interactions/api/vendor/reviews/:reviewId/reply
// @access  Private (Vendor)
export const replyToReview = async (req, res) => {
  try {
    const vendorUserId = req.user.id; // This is the User ID of the logged-in vendor
    const { reviewId } = req.params;
    const { replyText } = req.body;

    // 1. Find the VendorProfile ID associated with this User
    const vendorProfile = await prisma.vendorProfile.findUnique({
      where: { userId: vendorUserId }
    });

    if (!vendorProfile) {
      return res.status(404).json({ success: false, message: 'Vendor profile not found' });
    }

    // 2. Find the review AND ensure it belongs to this vendor
    const review = await prisma.review.findFirst({
      where: {
        id: reviewId,            // The review we want to reply to
        vendorId: vendorProfile.id // SECURITY CHECK: Must belong to this vendor
      }
    });

    if (!review) {
      return res.status(404).json({ success: false, message: 'Review not found or does not belong to you.' });
    }

    // 3. Update the review with the reply
    const updatedReview = await prisma.review.update({
      where: { id: reviewId },
      data: {
        reply: replyText,
        repliedAt: new Date() // Ensure your Schema has this field, or just check 'updatedAt'
      }
    });

    res.json({ success: true, data: updatedReview });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server Error' });
=======
// @route   POST /interactions/api/vendor/reviews/:id/reply
// @access  Private (Vendor)
export const replyToReview = async (req, res) => {
  try {
    const vendorUserId = req.user.id;

    // The route declares `:id`; this read `req.params.reviewId`, which was
    // always undefined.
    const reviewId = parseInt(req.params.id);
    if (Number.isNaN(reviewId)) {
      return res.status(400).json({ success: false, message: 'Invalid review id.' });
    }

    // Swagger documents this field as `reply`, the original code read
    // `replyText`. Accept either rather than silently storing undefined.
    const replyText = (req.body?.reply ?? req.body?.replyText ?? '').toString().trim();
    if (!replyText) {
      return res.status(400).json({ success: false, message: 'Reply text is required.' });
    }
    if (replyText.length > 2000) {
      return res.status(400).json({ success: false, message: 'Reply is too long (max 2000 characters).' });
    }

    // Ownership check. Review.vendorId holds the vendor's *User* id (it is set
    // from Service.vendorId, which references User). The previous version
    // compared it against VendorProfile.id — a different table's primary key —
    // so this lookup could never match and every reply 404'd.
    const updated = await prisma.review.updateMany({
      where: { id: reviewId, vendorId: vendorUserId },
      data: { reply: replyText, repliedAt: new Date() },
    });

    if (updated.count === 0) {
      return res.status(404).json({
        success: false,
        message: 'Review not found or does not belong to you.',
      });
    }

    const review = await prisma.review.findUnique({
      where: { id: reviewId },
      select: { id: true, reply: true, repliedAt: true },
    });

    res.json({ success: true, data: review });
  } catch (error) {
    console.error('Reply To Review Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
  }
};



