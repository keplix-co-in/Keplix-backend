import prisma from 'file:///C:/keplix-frontend-master/keplix-backend/util/prisma.js';
import { initiateVendorPayout } from "../../util/payoutHelper.js";
import { createNotification } from "../../util/notificationHelper.js";



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
      return res.status(403).json({ message: "Not authorized to confirm this booking" });
    }

    // Check booking status - must be "service_completed" by vendor
    if (booking.status !== "service_completed") {
      return res.status(400).json({ 
        message: "Cannot confirm booking. Vendor must mark service as completed first.",
        currentStatus: booking.status 
      });
    }

    // User confirms service is satisfactory
    if (confirmed === true) {
      // 1. Update booking status to user_confirmed
      await prisma.booking.update({
        where: { id: bookingId },
        data: { status: "user_confirmed" }
      });

      // 2. Create review if rating provided
      if (rating) {
        await prisma.review.create({
          data: {
            bookingId: bookingId,
            userId: userId,
            rating: parseInt(rating),
            comment: comment || null
          }
        });
      }

      // 3. TRIGGER VENDOR PAYOUT (CRITICAL)
      const payment = booking.payment;
      
      if (!payment) {
        return res.status(400).json({ 
          message: "No payment found for this booking" 
        });
      }

      if (payment.status !== "success") {
        return res.status(400).json({ 
          message: "Payment not successful, cannot process payout" 
        });
      }

      if (payment.vendorPayoutStatus === "paid") {
        return res.status(400).json({ 
          message: "Vendor payout already processed" 
        });
      }

      if (payment.vendorPayoutStatus !== "pending") {
        return res.status(400).json({ 
          message: `Cannot process payout. Current status: ${payment.vendorPayoutStatus}` 
        });
      }

      // Initiate payout to vendor
      try {
        console.log(`ðŸ”„ [ESCROW] User confirmed booking ${bookingId}. Initiating payout...`);
        
        const payoutResult = await initiateVendorPayout(payment, booking.service.vendorId);
        
        if (payoutResult.success) {
          // Update payment record with payout details
          await prisma.payment.update({
            where: { id: payment.id },
            data: {
              vendorPayoutStatus: "paid",
              vendorPayoutId: payoutResult.payoutId
            }
          });

          console.log(`âœ… [ESCROW] Payout successful! PayoutID: ${payoutResult.payoutId}`);
          console.log(`ðŸ’° [ESCROW] Amount: â‚¹${payment.vendorAmount} sent to vendor ${booking.service.vendorId}`);

          // Notify vendor of payment
          await createNotification(
            booking.service.vendorId,
            "ðŸ’° Payment Received!",
            `â‚¹${payment.vendorAmount} has been transferred to your account for ${booking.service.name}`
          );

          return res.json({ 
            success: true,
            message: "Service confirmed. Vendor payout processed successfully.",
            booking: {
              id: bookingId,
              status: "user_confirmed",
              payoutStatus: "paid",
              vendorAmount: payment.vendorAmount,
              platformFee: payment.platformFee
            }
          });

        } else {
          // Payout failed - mark as failed
          await prisma.payment.update({
            where: { id: payment.id },
            data: { vendorPayoutStatus: "failed" }
          });

          console.error(`âŒ [ESCROW] Payout failed: ${payoutResult.error || payoutResult.message}`);
          
          return res.status(500).json({ 
            message: "Service confirmed but payout failed. Admin will review.",
            error: payoutResult.error || payoutResult.message
          });
        }

      } catch (payoutError) {
        console.error(`âŒ [ESCROW] Payout error:`, payoutError);
        
        // Mark payout as failed
        await prisma.payment.update({
          where: { id: payment.id },
          data: { vendorPayoutStatus: "failed" }
        });

        return res.status(500).json({ 
          message: "Service confirmed but payout failed. Admin will review.",
          error: payoutError.message 
        });
      }

    } else {
      // User is not satisfied - this should trigger dispute flow
      return res.status(400).json({ 
        message: "Service not confirmed. Please use the dispute endpoint if you have concerns." 
      });
    }

  } catch (error) {
    console.error("Service confirmation error:", error);
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

    console.log(`âš ï¸  [DISPUTE] Booking ${bookingId} disputed by user ${userId}`);
    console.log(`ðŸ“ [DISPUTE] Reason: ${reason}`);
    console.log(`ðŸ”’ [DISPUTE] Payout blocked. Admin review required.`);

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


