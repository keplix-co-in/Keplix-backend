import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// @desc    Get reviews for this vendor's services
// @route   GET /interactions/api/vendor/reviews/
export const getVendorReviews = async (req, res) => {
    try {
        const vendorId = req.user.id; // From authMiddleware

        const reviews = await prisma.review.findMany({
            where: {
                booking: {
                    service: {
                        vendorId: vendorId
                    }
                }
            },
            include: { 
                user: { include: { userProfile: true } }, // The reviewer details
                booking: { 
                    select: {
                        id: true,
                        booking_date: true,
                        service: {
                            select: {
                                name: true
                            }
                        }
                    } 
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        res.json(reviews);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Reply to a review
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
  }
};
