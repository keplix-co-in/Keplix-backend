import { PrismaClient } from "@prisma/client";
import { initiateVendorPayout } from "../../util/payoutHelper.js";
import { sendPushNotification } from "../../util/communication.js";

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
      },
      orderBy: { booking_date: "desc" },
    });

    res.json(bookings);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Update booking status
// @route   PATCH /service_api/bookings/:id/
export const updateBookingStatus = async (req, res) => {
  const { status } = req.body;
  try {
    const booking = await prisma.booking.update({
      where: { id: parseInt(req.params.id) },
      data: { status },
      // Include service relation so we can find vendor for payout
      include: {
        service: true
      }
    });

    //socket.io instance
    const io = req.app.get("io");   
    // Notify user about booking status update
    io.to(`user_${booking.userId}`).emit("booking_updated", {
      bookingId: booking.id,
      status: booking.status,
      message: "Your booking status has been updated",
    });

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
        } else if (status === 'service_completed') {
            title = "Service Completed";
            body = "The vendor has marked your service as completed. Please confirm to release payment.";
        } else if (status === 'cancelled') {
             title = "Booking Cancelled";
             body = "Your booking request was cancelled.";
        }

        sendPushNotification(userForPush.fcmToken, title, body, { bookingId: booking.id.toString() }).catch(err => console.error("Push Error", err));
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
