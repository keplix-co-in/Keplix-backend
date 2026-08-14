import prisma from "../../util/prisma.js";
import { initiateVendorPayout } from "../../util/payoutHelper.js";
import { sendPushNotification } from "../../util/communication.js";
import { createNotification } from "../../util/notificationHelper.js";
import { assertHealthSheetPresent } from "../../services/healthSheetService.js";



// @desc    Get bookings for logged in vendor
// @route   GET /service_api/vendor/bookings/
export const getVendorBookings = async (req, res) => {
  try {
    const { status, date, date_from, date_to, serviceName, token, page = 1, limit = 50 } = req.query;
    const skip = (page - 1) * limit;

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
    // EXCEPTION: For completed/cancelled bookings, show all historical records
    const now = new Date();
    const hasDateFilter = date || date_from || date_to;
    const isCompletedStatus = status && (status.includes('completed') || status.includes('cancelled'));
    
    if (!hasDateFilter && !isCompletedStatus) { // Only apply time filter when no specific date filters are set AND not completed/cancelled
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
        payment: true, // Include payment status
      },
      orderBy: { booking_date: "desc" },
      skip: Number(skip),
      take: Number(limit),
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
      } else {
        // Socket not available, notification already sent via push
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
  const { status, notes } = req.body;

  try {

    // Scoped to the caller's own services. This previously used findUnique on
    // the id alone, which meant any authenticated vendor could drive any
    // booking — including to service_completed, the step that puts a booking
    // on the escrow-release path. respondToServiceRequest above already
    // filters this way; this function was simply missing it.
    const currentBooking = await prisma.booking.findFirst({
      where: {
        id: parseInt(req.params.id),
        service: {
          vendorId: req.user.id
        }
      },
      select: { id: true, status: true, createdAt: true }
    });

    // Deliberately 404, not 403: a vendor should not be able to probe which
    // booking ids exist on other vendors.
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

        // Mandatory-inspection gate. Same rule, same rollout anchoring as
        // walk-in job completion — see services/healthSheetService.js and
        // the PlatformSettings comment in schema.prisma. 409, not 400, so the
        // app can branch on this specific code and deep-link into the
        // inspection form rather than showing a generic validation error.
        // Anchored to currentBooking.createdAt, not "now": flipping the
        // rollout flag must never strand a booking that was already in
        // flight before any garage had a way to see this form — completion
        // is what releases escrow.
        //
        // Gated on 'completed' too, not just 'service_completed': despite
        // this function's own comments describing service_completed as the
        // completion step, the partner app's actual ServiceCompletion.jsx
        // screen submits status: 'completed' directly. A gate that only
        // checked 'service_completed' would never fire on a real completion
        // — caught by testing the request the app actually sends, not the
        // string this code talks about sending.
        if (status === 'service_completed' || status === 'completed') {
          const gate = await assertHealthSheetPresent({
            createdAt: currentBooking.createdAt,
            bookingId: currentBooking.id,
          });
          if (!gate.ok) {
            return res.status(409).json({ code: gate.code, message: gate.message });
          }
        }
    }

    // Prepare update data
    const updateData = { status };
    if (notes) {
      updateData.notes = notes;
    }

    // uploadFieldss sets req.files to an OBJECT keyed by field name, not an
    // array. The previous code did `(req.files || []).length > 0`, which is
    // `undefined > 0` — always false — so completion images were silently
    // never saved. It also read file.path, which is empty under
    // multer.memoryStorage(); the Cloudinary URL is on file.cloudinary.
    const uploadedFiles = Object.values(req.files ?? {}).flat();
    const imageUrls = uploadedFiles
      .map((file) => file?.cloudinary?.secure_url)
      .filter(Boolean);

    if (imageUrls.length > 0) {
        // The column is `String?`, so an array would be a type error. Nothing
        // reads this back yet (it has never contained data), so comma-separated
        // is a free choice — but whatever consumes it must split on ','.
        updateData.completion_images = imageUrls.join(',');
    }

    const booking = await prisma.booking.update({
      where: { id: parseInt(req.params.id) },
      data: updateData,
      // Include service relation so we can find vendor for payout
      include: {
        service: true
      }
    });
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




