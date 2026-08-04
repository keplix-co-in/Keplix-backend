import prisma from "../../util/prisma.js";
import { addPayoutJob } from "../../queues/payoutQueue.js";
import { createNotification, sendPushNotification } from "../../util/notificationHelper.js";
import { updateVendorRatingStats } from "../../util/ratingHelper.js";

/**
 * @desc    User confirms service completion
 * @route   POST /service_api/user/:userId/bookings/:id/confirm
 * @access  Protected (User only)
 * 
 * CRITICAL ESCROW ENDPOINT:
 * - User confirms vendor completed service satisfactorily
 * - This triggers the payout to vendor via BullMQ background job
 * - Money moves from escrow → vendor account
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

    // Wrap DB operations in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // 1. Re-fetch booking inside transaction to ensure consistency
      const currentBooking = await tx.booking.findUnique({
        where: { id: bookingId },
        include: {
          service: { select: { vendorId: true, name: true } },
          payment: true
        }
      });

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

      // 4. Update payout status to 'processing'
      await tx.payment.update({
        where: { id: payment.id },
        data: { vendorPayoutStatus: "processing" }
      });

      return {
        success: true,
        paymentId: payment.id,
        vendorId: currentBooking.service.vendorId,
        bookingId: bookingId
      };
    }, {
      timeout: 20000 // External payout APIs can be slow
    });

    // 5. QUEUE THE PAYOUT JOB (Outside transaction)
    await addPayoutJob({
      paymentId: result.paymentId,
      vendorId: result.vendorId,
      bookingId: result.bookingId
    });

    return res.json({ 
      success: true,
      message: "Service confirmed. Vendor payout is being processed.",
      booking: {
        id: bookingId,
        status: "user_confirmed",
        payoutStatus: "processing"
      }
    });

  } catch (error) {
    console.error("Service confirmation error:", error);
    
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


