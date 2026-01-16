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
        } else if (status === 'completed') {
            title = "Service Completed";
            body = "Your service has been marked as completed.";
        } else if (status === 'cancelled') {
             title = "Booking Cancelled";
             body = "Your booking request was cancelled.";
        }

        sendPushNotification(userForPush.fcmToken, title, body, { bookingId: booking.id.toString() }).catch(err => console.error("Push Error", err));
    }

    // === AUTOMATED PAYOUT LOGIC ===
    if (status === 'completed' || status === 'service_completed') {
        const payment = await prisma.payment.findUnique({
            where: { bookingId: booking.id }
        });

        if (payment && payment.status === 'success' && payment.vendorPayoutStatus === 'pending') {
            // Find specific service provider if needed, or just the vendor owner of the service
            // The booking already links to a service which links to a vendor (User)
            const service = await prisma.service.findUnique({ 
                where: { id: booking.service.id },
                select: { vendorId: true }
            });

            // Run Payout
            try {
                const payoutResult = await initiateVendorPayout(payment, service.vendorId);
                
                if (payoutResult.success) {
                    await prisma.payment.update({
                        where: { id: payment.id },
                        data: {
                            vendorPayoutStatus: 'paid',
                            vendorPayoutId: payoutResult.payoutId
                        }
                    });
                }
            } catch (err) {
                console.error("Payout Failed", err);
                await prisma.payment.update({
                    where: { id: payment.id },
                    data: { vendorPayoutStatus: 'failed' }
                });
            }
        }
    }
    
    res.json(booking);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};
