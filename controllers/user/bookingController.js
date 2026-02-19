import prisma from "../../util/prisma.js";
import { createNotification } from "../../util/notificationHelper.js";


// @desc    Get payment by bookingId
// @route   GET /service_api/bookings/:bookingId/payment
export const getPaymentByBooking = async (req, res) => {
  try {
    const bookingId = parseInt(req.params.bookingId);
    if (isNaN(bookingId)) {
      return res.status(400).json({ message: "Invalid bookingId" });
    }
    // Only allow if user owns the booking
    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, userId: req.user.id },
      include: { payment: true }
    });
    if (!booking) {
      return res.status(404).json({ message: "Booking not found or not authorized" });
    }
    if (!booking.payment) {
      return res.status(404).json({ message: "No payment found for this booking" });
    }
    res.json(booking.payment);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Get bookings for logged in user
// @route   GET /service_api/user/bookings/
export const getUserBookings = async (req, res) => {
  try {
    // query params
    const { page = 1, limit = 10, search } = req.query;
    const skip = (page - 1) * limit;

    let where = { userId: req.user.id };
    if (search) {
      where.OR = [
        {
          service: {
            name: { contains: search, mode: "insensitive" },
          },
        },
        {
          notes: { contains: search, mode: "insensitive" },
        },
        {
          status: { contains: search, mode: "insensitive" },
        },
      ];
    }

    const bookings = await prisma.booking.findMany({
      where: { userId: req.user.id },
      skip: Number(skip),
      take: Number(limit),
      include: {
        service: {
          include: { vendor: { include: { vendorProfile: true } } },
        },
      },
      orderBy: { booking_date: "desc" },
    });

    const total = await prisma.booking.count({ where });

    const formattedBookings = bookings.map((booking) => ({
      ...booking,
      service: {
        ...booking.service,
        image_url: booking.service.image_url
          ? `${req.protocol}://${req.get("host")}${booking.service.image_url}`
          : null,
        image: booking.service.image_url
          ? `${req.protocol}://${req.get("host")}${booking.service.image_url}`
          : null,
        vendor_name:
          booking.service.vendor?.vendorProfile?.business_name || "Vendor",
        vendor_image: booking.service.vendor?.vendorProfile?.image
          ? `${req.protocol}://${req.get("host")}${booking.service.vendor.vendorProfile.image}`
          : null,
        cover_image: booking.service.vendor?.vendorProfile?.cover_image
          ? `${req.protocol}://${req.get("host")}${booking.service.vendor.vendorProfile.cover_image}`
          : null,
      },
    }));

    res.json(formattedBookings);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Get single booking
// @route   GET /service_api/user/:userId/bookings/:id
export const getSingleBooking = async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id);
    const userId = parseInt(req.params.userId);

    const booking = await prisma.booking.findFirst({
      where: { 
        id: bookingId,
        userId: userId // Ensure user owns this booking
      },
      include: {
        service: {
          include: { vendor: { include: { vendorProfile: true } } },
        },
        payment: true,
        review: true
      },
    });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    res.json(booking);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Create a new booking request (vendor must accept before payment)
// @route   POST /service_api/bookings/
export const createBooking = async (req, res) => {

    const { serviceId, booking_date, booking_time, notes } = req.body;
    console.log("Creating booking request for user:", req.user.id);

    try {
        // Create booking with vendor_status = 'pending' (waiting for vendor acceptance)
        const booking = await prisma.booking.create({
            data: {
                userId: req.user.id,
                serviceId: serviceId, // Already validated as number by Zod
                booking_date: new Date(booking_date),
                booking_time,
                notes,
                vendor_status: 'pending', // Vendor must accept/reject
                status: 'pending', // Overall status
                conversation: {
                    create: {} // Automatically create a conversation for this booking
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

        // Notify Vendor about new request
        if (booking.service && booking.service.vendorId) {
            console.log(`ðŸ“¨ [BOOKING] New booking created! ID: ${booking.id}, Vendor: ${booking.service.vendorId}, Service: ${booking.service.name}`);
            
            try {
                await createNotification(
                    booking.service.vendorId, 
                    "New Service Request", 
                    `${booking.user.userProfile?.name || 'A user'} requested ${booking.service.name} on ${new Date(booking_date).toLocaleDateString()}`,
                    { type: 'NEW_BOOKING_ALERT', bookingId: booking.id }
                );
                console.log(`âœ… [BOOKING] Notification sent to vendor ${booking.service.vendorId}`);
            } catch (notifError) {
                console.error(`âŒ [BOOKING] Failed to send notification:`, notifError);
            }
            
            // Get socket instance and notify vendor in real-time
            const io = req.app.get("io");
            if (io) {
                io.to(`user_${booking.service.vendorId}`).emit("new_service_request", {
                    bookingId: booking.id,
                    service: booking.service.name,
                    userName: booking.user.userProfile?.name || 'User',
                    date: booking_date,
                    time: booking_time,
                    message: "You have a new service request! Please accept or reject."
                });
            }
        }

        res.status(201).json({
            ...booking,
            message: "Service request sent to vendor. Waiting for acceptance."
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

// @desc    Check if booking request was accepted by vendor (for payment)
// @route   GET /service_api/user/:userId/bookings/:id/can-pay
export const canProceedToPayment = async (req, res) => {
  const bookingId = parseInt(req.params.id);
  
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        service: true,
        payment: true
      }
    });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    // Ensure user owns the booking
    if (booking.userId !== req.user.id) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Check vendor acceptance status
    const canPay = booking.vendor_status === 'accepted' && !booking.payment;

    res.json({
      canPay,
      vendor_status: booking.vendor_status,
      status: booking.status,
      hasPayment: !!booking.payment,
      booking
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Update/Cancel booking
// @route   PUT /service_api/user/:userId/bookings/update/:id
export const updateBooking = async (req, res) => {
  const { status, booking_date, booking_time, notes } = req.body;
  const bookingId = parseInt(req.params.id);

  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    // Ensure user owns the booking
    if (booking.userId !== req.user.id) {
      return res
        .status(403)
        .json({ message: "Not authorized to update this booking" });
    }

    // Only allow cancellation if status is pending or confirmed (not completed)
    if (status === "cancelled") {
      if (booking.status === "completed" || booking.status === "cancelled") {
        return res
          .status(400)
          .json({
            message: `Cannot cancel booking that is already ${booking.status}`,
          });
      }
    }

    const updatedBooking = await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: status || undefined,
        booking_date: booking_date ? new Date(booking_date) : undefined,
        booking_time: booking_time || undefined,
        notes: notes || undefined,
      },
      include: { service: true }
    });

    if (status === "cancelled") {
         await createNotification(
            updatedBooking.service.vendorId,
            "Booking Cancelled",
             `Booking for ${updatedBooking.service.name} was cancelled by the user.`
        );

        // Socket notify vendor
        const io = req.app.get("io");
        if (io) {
            io.to(`user_${updatedBooking.service.vendorId}`).emit("booking_cancelled", {
                bookingId: updatedBooking.id,
                service: updatedBooking.service.name,
                message: "This booking was cancelled by the user."
            });
        }
    }

    res.json(updatedBooking);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};


