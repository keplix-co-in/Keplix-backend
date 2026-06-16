import prisma from "../../util/prisma.js";
import { initiateVendorPayout } from "../../util/payoutHelper.js";
import { createNotification } from "../../util/notificationHelper.js";
import { updateVendorRatingStats } from "../../util/ratingHelper.js";



/**
 * @desc    User confirms service completion
 * @route   POST /service_api/user/:userId/bookings/:id/confirm
 * @access  Protected (User only)
 * 
 * CRITICAL ESCROW ENDPOINT:
 * - User confirms vendor completed service satisfactorily
 * - This triggers the payout to vendor
 * - Money moves from escrow â†’ vendor account
 */
export const confirmServiceCompletion = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const bookingId = parseInt(req.params.id);
    const { confirmed, rating, comment } = req.body;

    if (isNaN(userId) || isNaN(bookingId)) {
      return res.status(400).json({ message: "Invalid user or booking ID" });
    }

    // Initial check (outside transaction for efficiency)
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        service: {
          select: { vendorId: true, name: true }
        },
        payment: true
      }
    });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (booking.userId !== userId) {
      return res.status(403).json({ message: "Not authorized to confirm this booking" });
    }

    if (booking.status !== "service_completed") {
      return res.status(400).json({ 
        message: "Cannot confirm booking. Vendor must mark service as completed first.",
        currentStatus: booking.status 
      });
    }

    if (confirmed !== true) {
      return res.status(400).json({ 
        message: "Service not confirmed. Please use the dispute endpoint if you have concerns." 
      });
    }

    // Wrap EVERYTHING in a single transaction to ensure atomicity
    const result = await prisma.$transaction(async (tx) => {
      // 1. Re-fetch booking inside transaction to ensure consistency and lock row if needed
      const currentBooking = await tx.booking.findUnique({
        where: { id: bookingId },
        include: {
          service: { select: { vendorId: true, name: true } },
          payment: true
        }
      });

      // Double check status inside transaction to prevent race conditions
      if (currentBooking.status !== "service_completed") {
        throw new Error(`Booking status has changed to ${currentBooking.status}`);
      }

      const payment = currentBooking.payment;
      if (!payment) {
        throw new Error("No payment found for this booking");
      }

      if (payment.status !== "success") {
        throw new Error("Payment not successful, cannot process payout");
      }

      if (payment.vendorPayoutStatus === "paid") {
        throw new Error("Vendor payout already processed");
      }

      // 2. Update booking status to user_confirmed
      await tx.booking.update({
        where: { id: bookingId },
        data: { status: "user_confirmed" }
      });

      // 3. Create review if rating provided
      if (rating !== undefined && rating !== null) {
        const ratingValue = Math.round(parseFloat(rating));
        if (!isNaN(ratingValue)) {
          const vendorId = currentBooking.service?.vendorId;
          
          // Check if review already exists to avoid unique constraint error
          const existingReview = await tx.review.findUnique({
            where: { bookingId: bookingId }
          });

          if (!existingReview) {
            await tx.review.create({
              data: {
                bookingId: bookingId,
                userId: userId,
                vendorId: vendorId,
                rating: ratingValue,
                comment: comment || null
              }
            });

            if (vendorId) {
              await updateVendorRatingStats(tx, vendorId, ratingValue, false);
            }
          }
        }
      }

      // 4. TRIGGER VENDOR PAYOUT
      // Note: initiateVendorPayout calls external API (Stripe/Razorpay)
      const payoutResult = await initiateVendorPayout(payment, currentBooking.service.vendorId);
      
      if (payoutResult.success) {
        // Update payment record with payout details
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            vendorPayoutStatus: "paid",
            vendorPayoutId: payoutResult.payoutId
          }
        });

        return { 
          success: true, 
          vendorAmount: payment.vendorAmount, 
          serviceName: currentBooking.service.name,
          vendorId: currentBooking.service.vendorId,
          payoutId: payoutResult.payoutId,
          platformFee: payment.platformFee
        };
      } else {
        // Payout failed - mark as failed in DB within the same transaction
        // This ensures the booking stays 'user_confirmed' but we know payout failed.
        await tx.payment.update({
          where: { id: payment.id },
          data: { vendorPayoutStatus: "failed" }
        });
        
        return { 
          success: false, 
          error: payoutResult.error || payoutResult.message,
          vendorId: currentBooking.service.vendorId 
        };
      }
    }, {
      timeout: 20000 // External payout APIs can be slow
    });

    // 5. Post-transaction actions (Notifications)
    if (result.success) {
      await createNotification(
        result.vendorId,
        "ðŸ’° Payment Received!",
        `â‚¹${result.vendorAmount} has been transferred to your account for ${result.serviceName}`
      );

      return res.json({ 
        success: true,
        message: "Service confirmed. Vendor payout processed successfully.",
        booking: {
          id: bookingId,
          status: "user_confirmed",
          payoutStatus: "paid",
          vendorAmount: result.vendorAmount,
          platformFee: result.platformFee
        }
      });
    } else {
      console.error(`âŒ [ESCROW] Payout failed: ${result.error}`);
      return res.status(500).json({ 
        message: "Service confirmed but payout failed. Admin will review.",
        error: result.error
      });
    }

  } catch (error) {
    console.error("Service confirmation error:", error);
    
    // Handle specific error messages from transaction
    const clientErrors = [
      "Booking status has changed",
      "No payment found",
      "Payment not successful",
      "Vendor payout already processed"
    ];

    if (clientErrors.some(msg => error.message.includes(msg))) {
      return res.status(400).json({ message: error.message });
    }

    res.status(500).json({ 
      message: "Service confirmation failed",
      error: error.message 
    });
  }
};

/**
 * @desc    User disputes service completion
 * @route   POST /service_api/user/:userId/bookings/:id/dispute
 * @access  Protected (User only)
 * 
 * CRITICAL: Prevents payout and requires admin review
 */
export const disputeServiceCompletion = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const bookingId = parseInt(req.params.id);
    const { reason } = req.body;

    if (!reason || reason.trim().length < 10) {
      return res.status(400).json({ 
        message: "Please provide a detailed reason (minimum 10 characters)" 
      });
    }

    // Verify user owns this booking
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        service: {
          select: { vendorId: true, name: true }
        },
        payment: true
      }
    });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (booking.userId !== userId) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Check if already disputed
    if (booking.status === "disputed") {
      return res.status(400).json({ message: "This booking is already under dispute" });
    }

    // Update booking status to disputed
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: "disputed" }
    });

    // Create dispute record (Note: Need to create Dispute table first)
    // For now, we'll use notifications to alert admin
    
    // Notify vendor
    const vendor = await prisma.user.findUnique({
      where: { id: booking.service.vendorId },
      select: { fcmToken: true, email: true }
    });

    if (vendor && vendor.fcmToken) {
      await sendPushNotification(
        vendor.fcmToken,
        "âš ï¸ Service Disputed",
        `A customer has raised a dispute for ${booking.service.name}. Admin will review.`,
        { bookingId: bookingId.toString(), type: "dispute" }
      );
    }

    return res.json({
      success: true,
      message: "Dispute raised successfully. Our team will review and contact you within 24 hours.",
      booking: {
        id: bookingId,
        status: "disputed",
        reason: reason
      }
    });

  } catch (error) {
    console.error("Dispute creation error:", error);
    res.status(500).json({ 
      message: "Failed to create dispute",
      error: error.message 
    });
  }
};


