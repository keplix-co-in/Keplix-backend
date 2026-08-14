import prisma from "../../util/prisma.js";
import { sendPushNotification } from "../../util/notificationHelper.js";
import { confirmBookingAndQueuePayout, BookingConfirmationError } from "../../services/bookingConfirmationService.js";

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

    if (confirmed !== true) {
      return res.status(400).json({
        message: "Service not confirmed. Please use the dispute endpoint if you have concerns."
      });
    }

    await confirmBookingAndQueuePayout({ userId, bookingId, rating, comment });

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

    if (error instanceof BookingConfirmationError) {
      return res.status(error.statusCode).json({ message: error.message });
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


