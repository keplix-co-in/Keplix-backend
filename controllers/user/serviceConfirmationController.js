import prisma from "../../util/prisma.js";
import { sendPushNotification } from "../../util/notificationHelper.js";
import { renderNotification, NOTIFICATION_TYPES } from "../../util/notificationTemplates.js";
import { confirmBookingAndQueuePayout, BookingConfirmationError } from "../../services/bookingConfirmationService.js";
import { parseIdParam } from "../../util/parseIdParam.js";

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
    // Ownership must be decided from the authenticated caller, never from the
    // URL — req.params.userId is attacker-controlled and was previously
    // trusted here, letting any user drain another user's escrow by swapping
    // the userId in the path.
    const userId = req.user.id;
    // parseIdParam, not parseInt: parseInt("12abc") is 12 and an id past
    // INT4 reached Prisma as a 500 (see util/parseIdParam.js).
    const bookingId = parseIdParam(req.params.id);
    const { confirmed, rating, comment } = req.body;

    if (isNaN(userId) || bookingId === null) {
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
    // As above: ownership is decided from the authenticated caller, not the
    // URL parameter.
    const userId = req.user.id;
    // A non-numeric id used to reach Prisma as NaN and come back as a 500.
    const bookingId = parseIdParam(req.params.id);
    if (bookingId === null) {
      return res.status(400).json({ message: "Invalid booking ID" });
    }
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

    // Check if already disputed. 409 (was 400): the request is valid, the
    // booking is just no longer in a state that accepts it -- same answer as
    // the state check below and the guarded write.
    if (booking.status === "disputed") {
      return res.status(409).json({ message: "This booking is already under dispute" });
    }

    // A dispute is the customer's response to the vendor's claim that the
    // service is done -- confirmServiceCompletion requires the same
    // precondition (status === "service_completed") for the opposite answer.
    // Without this check, any booking could be disputed regardless of state
    // -- including one still 'pending' vendor acceptance, where no service
    // has happened at all -- which let a customer short-circuit cancellation
    // (NON_CANCELLABLE excludes 'disputed') on a booking nothing was ever
    // done on (audit: bookingcust flow, 2026-09-28).
    //
    // 409 (was 400) for the same reason as above: a dispute on, say, a
    // user_confirmed booking is a state conflict, not a malformed request.
    if (booking.status !== "service_completed") {
      return res.status(409).json({
        message: "You can only dispute a booking after the vendor has marked the service as completed.",
      });
    }

    // Guarded write. The check above was a pre-read: the customer confirming
    // from another device or the auto-confirm cron can move the booking to
    // user_confirmed (payout queued) in between, and an unguarded update then
    // flipped a paid-out booking to disputed. With the WHERE, whichever write
    // lands first wins and the other sees count 0.
    //
    // The reason is persisted (it used to exist only in this response body,
    // so the admin resolving the dispute never saw what the customer said).
    const { count } = await prisma.booking.updateMany({
      where: { id: bookingId, userId, status: "service_completed" },
      data: {
        status: "disputed",
        dispute_reason: reason.trim(),
        disputed_at: new Date(),
      },
    });
    if (count === 0) {
      return res.status(409).json({
        message: "This booking can no longer be disputed. It may have just been confirmed.",
      });
    }

    // Create dispute record (Note: Need to create Dispute table first)
    // For now, we'll use notifications to alert admin
    
    // Notify vendor. Best-effort: the dispute is already committed, and a
    // push/lookup failure used to surface as "Failed to create dispute" (500)
    // for a dispute that HAD been created -- so the customer retried into a
    // 409 and believed nothing had been recorded.
    try {
      const vendor = await prisma.user.findUnique({
        where: { id: booking.service.vendorId },
        select: { pushToken: true, email: true }
      });

      // Was `vendor.fcmToken`, which Expo can only reject -- an FCM token is not
      // an ExponentPushToken, so the dispute push never once reached a vendor.
      if (vendor && vendor.pushToken) {
        const disputeNotification = renderNotification(NOTIFICATION_TYPES.SERVICE_DISPUTED, {
          serviceName: booking.service?.name,
          bookingId: bookingId.toString(),
        });
        await sendPushNotification(
          vendor.pushToken,
          disputeNotification.title,
          disputeNotification.body,
          disputeNotification.data
        );
      }
    } catch (notifyError) {
      console.error('Failed to notify vendor of dispute for booking', bookingId, notifyError);
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


