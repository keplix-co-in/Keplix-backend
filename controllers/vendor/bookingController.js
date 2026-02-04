import { PrismaClient } from "@prisma/client";
import { initiateVendorPayout } from "../../util/payoutHelper.js";
import { sendPushNotification } from "../../util/communication.js";
import { createNotification } from "../../util/notificationHelper.js";

const prisma = new PrismaClient();

// @desc    Get bookings for logged in vendor
// @route   GET /service_api/vendor/bookings/
export const getVendorBookings = async (req, res) => {
  try {
    const { status, date, date_from, date_to, serviceName, token } = req.query;

    // Find all services by this vendor first
    const vendorServices = await prisma.service.findMany({
      where: { vendorId: req.user.id },
      select: { id: true },
    });
    const serviceIds = vendorServices.map((s) => s.id);

    let query = {
      serviceId: { in: serviceIds },
    };

    // Apply filters
    if (status) query.status = { in: status.split(",") };
    if (date) query.booking_date = new Date(date);
    if (date_from || date_to) {
      query.booking_date = {};
      if (date_from) query.booking_date.gte = new Date(date_from);
      if (date_to) query.booking_date.lte = new Date(date_to);
    }
    if (serviceName) query.service = { name: { contains: serviceName } };
    if (token) query.id = parseInt(token);

    const bookings = await prisma.booking.findMany({
      where: query,
      include: {
        user: { include: { userProfile: true } },
        service: true,
        conversation: true, // Include conversation to get conversationId for chat
      },
      orderBy: { booking_date: "desc" },
    });

    res.json(bookings);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Accept or reject a service request
// @route   PATCH /service_api/vendor/bookings/:id/respond
export const respondToServiceRequest = async (req, res) => {
  const { vendor_status } = req.body; // 'accepted' or 'rejected'
  const bookingId = parseInt(req.params.id);

  try {
    // Verify booking exists and belongs to vendor's services
    const booking = await prisma.booking.findFirst({
      where: { 
        id: bookingId,
        service: {
          vendorId: req.user.id
        }
      },
      include: {
        service: true,
        user: {
          include: {
            userProfile: true
          }
        }
      }
    });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found or unauthorized" });
    }

    if (booking.vendor_status !== 'pending') {
      return res.status(400).json({ 
        message: `Request already ${booking.vendor_status}` 
      });
    }

    // Update vendor_status
    const updatedBooking = await prisma.booking.update({
      where: { id: bookingId },
      data: { 
        vendor_status,
        status: vendor_status === 'accepted' ? 'confirmed' : 'cancelled'
      },
      include: {
        service: true,
        user: {
          include: {
            userProfile: true
          }
        }
      }
    });

    // Get socket instance
    const io = req.app.get("io");

    // Notify user about vendor's response
    if (vendor_status === 'accepted') {
      // Send notification
      await createNotification(
        booking.userId,
        "Request Accepted!",
        `${booking.service.name} request accepted. You can now proceed with payment.`
      );

      // Socket notification
      if (io) {
        io.to(`user_${booking.userId}`).emit("request_accepted", {
          bookingId: booking.id,
          service: booking.service.name,
          message: "Your service request was accepted! Proceed to payment."
        });
      }

      // Push notification
      const userForPush = await prisma.user.findUnique({
        where: { id: booking.userId },
        select: { fcmToken: true }
      });

      if (userForPush?.fcmToken) {
        sendPushNotification(
          userForPush.fcmToken,
          "Request Accepted!",
          `${booking.service.name} request accepted. Tap to proceed with payment.`,
          { bookingId: booking.id.toString(), action: 'payment' }
        ).catch(err => console.error("Push Error", err));
      }
    } else {
      // Request rejected
      await createNotification(
        booking.userId,
        "Request Declined",
        `Sorry, ${booking.service.name} request was declined by the vendor.`
      );

      if (io) {
        io.to(`user_${booking.userId}`).emit("request_rejected", {
          bookingId: booking.id,
          service: booking.service.name,
          message: "Your service request was declined."
        });
      }

      const userForPush = await prisma.user.findUnique({
        where: { id: booking.userId },
        select: { fcmToken: true }
      });

      if (userForPush?.fcmToken) {
        sendPushNotification(
          userForPush.fcmToken,
          "Request Declined",
          `Sorry, ${booking.service.name} request was declined.`,
          { bookingId: booking.id.toString() }
        ).catch(err => console.error("Push Error", err));
      }
    }

    res.json({
      ...updatedBooking,
      message: vendor_status === 'accepted' 
        ? "Service request accepted. User will be notified to proceed with payment."
        : "Service request declined."
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Update booking status
// @route   PATCH /service_api/bookings/:id/
export const updateBookingStatus = async (req, res) => {
  console.log('updateBookingStatus called with params:', req.params);
  const { status, notes } = req.body;
  const files = req.files || [];

  try {
    console.log('About to update booking with id:', req.params.id, 'status:', status);
    
    // Prepare update data
    const updateData = { status };
    if (notes) {
      updateData.notes = notes;
    }

    if (files.length > 0) {
        const imageUrls = files.map(file => file.path); // Cloudinary uses 'path' or 'secure_url'
        updateData.completion_images = imageUrls;
    }

    const booking = await prisma.booking.update({
      where: { id: parseInt(req.params.id) },
      data: updateData,
      // Include service relation so we can find vendor for payout
      include: {
        service: true
      }
    });
    console.log('Booking updated successfully:', booking.id, 'Files received:', files.length);
    console.log('Booking updated successfully:', booking.id);

    //socket.io instance
    const io = req.app.get("io");   
    // Notify user about booking status update
    try {
      io.to(`user_${booking.userId}`).emit("booking_updated", {
        bookingId: booking.id,
        status: booking.status,
        message: "Your booking status has been updated",
      });
    } catch (socketError) {
      console.error("Socket emit error:", socketError);
    }

    // === PUSH NOTIFICATION ===
    const userForPush = await prisma.user.findUnique({
        where: { id: booking.userId },
        select: { fcmToken: true }
    });

    if (userForPush && userForPush.fcmToken) {
        let title = "Booking Update";
        let body = `Your booking is now ${status}`;
        
        if (status === 'confirmed') {
            title = "Booking Accepted!";
            body = "The vendor has accepted your booking request.";
        } else if (status === 'completed') {
            title = "Service Completed";
            body = "The vendor has marked your service as completed. Please confirm to release payment.";
        } else if (status === 'cancelled') {
             title = "Booking Cancelled";
             body = "Your booking request was cancelled.";
        }

        // Store in DB
        await createNotification(booking.userId, title, body);

        sendPushNotification(userForPush.fcmToken, title, body, { bookingId: booking.id.toString() }).catch(err => console.error("Push Error", err));
    } else {
        // Even if no FCM token, store in DB
        let title = "Booking Update";
        let body = `Your booking is now ${status}`;
         if (status === 'confirmed') {
            title = "Booking Accepted!";
            body = "The vendor has accepted your booking request.";
        } else if (status === 'completed') {
             title = "Service Completed";
             body = "The vendor has marked your service as completed. Please confirm to release payment.";
        }
        await createNotification(booking.userId, title, body);
    }

    // ❌ REMOVED: Auto-payout when vendor marks completed
    // ✅ NEW FLOW: Payout only happens when USER confirms service completion
    // User must call POST /user/:userId/bookings/:id/confirm
    
    res.json(booking);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};
