import prisma from "../../util/prisma.js";
import { initiateVendorPayout } from "../../util/payoutHelper.js";
import { sendPushNotification } from "../../util/communication.js";
import { createNotification } from "../../util/notificationHelper.js";



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

    // For order alerts, exclude past bookings (bookings that have already passed)
    // Only show future bookings or bookings from today onwards
    const now = new Date();
    if (!date && !date_from && !date_to) { // Only apply time filter when no specific date filters are set
      query.booking_date = {
        gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()) // Today and future
      };
    }

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
      // Send notification (DB + Push)
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

    // Validate Status Transitions for "Ongoing" Tab Features
    const currentBooking = await prisma.booking.findUnique({
      where: { id: parseInt(req.params.id) },
      select: { status: true }
    });

    if (!currentBooking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (status) {
        // 1. Start Service: confirmed -> in_progress
        if (status === 'in_progress' && currentBooking.status !== 'confirmed' && currentBooking.status !== 'scheduled') {
            return res.status(400).json({ 
                message: `Cannot start service. Booking must be confirmed first. Current status: ${currentBooking.status}` 
            });
        }

        // 2. Complete Service: in_progress -> service_completed
        if (status === 'service_completed' && currentBooking.status !== 'in_progress') {
             // Allow skipping in_progress check if it was just confirmed (for quick jobs), but typically we want the flow.
             // For now, let's allow confirmed -> service_completed too for flexibility, or enforce flow?
             // User prompt: "in_progress -> service_completed" logic implies flow.
             if (currentBooking.status !== 'confirmed' && currentBooking.status !== 'scheduled') {
                return res.status(400).json({ 
                    message: `Cannot mark completed. Service must be in progress or confirmed. Current status: ${currentBooking.status}` 
                });
             }
        }
    }
    
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

    // === NOTIFICATIONS ===
    let title = "Booking Update";
    let body = `Your booking for ${booking.service.name} is now ${status}`;
    
    if (status === 'confirmed') {
        title = "Booking Accepted!";
        body = `The vendor has accepted your booking for ${booking.service.name}.`;
    } else if (status === 'service_completed') {
        title = "Service Completed";
        body = `The vendor has marked ${booking.service.name} as completed. Please confirm to release payment.`;
    } else if (status === 'cancelled') {
         title = "Booking Cancelled";
         body = `Your booking for ${booking.service.name} was cancelled.`;
    }

    // Store in DB & Send Push via Expo
    await createNotification(booking.userId, title, body);

    // Socket notification
    const io = req.app.get("io");   
    if (io) {
      try {
        io.to(`user_${booking.userId}`).emit("booking_updated", {
          bookingId: booking.id,
          status: booking.status,
          message: body,
        });
      } catch (socketError) {
        console.error("Socket emit error:", socketError);
      }
    }

    res.json(booking);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};




