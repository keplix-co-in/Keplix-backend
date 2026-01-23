import { PrismaClient } from "@prisma/client";
import { createNotification } from "../../util/notificationHelper.js";

const prisma = new PrismaClient();

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

// @desc    Create a new booking
// @route   POST /service_api/bookings/
export const createBooking = async (req, res) => {

    const { serviceId, booking_date, booking_time, notes } = req.body;

    try {
        const booking = await prisma.booking.create({
            data: {
                userId: req.user.id,
                serviceId: serviceId, // Already validated as number by Zod
                booking_date: new Date(booking_date),
                booking_time,
                notes,
                conversation: {
                    create: {} // Automatically create a conversation for this booking
                }
            },
            include: { service: true }
        });

        // Notify Vendor
        if (booking.service && booking.service.vendorId) {
             await createNotification(
                booking.service.vendorId, 
                "New Booking Request", 
                `New booking for ${booking.service.name} on ${booking_date}`
            );
        }

        res.status(201).json(booking);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

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
    }

    res.json(updatedBooking);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};
