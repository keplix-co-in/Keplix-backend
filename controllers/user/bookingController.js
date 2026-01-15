import { PrismaClient } from "@prisma/client";

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

    res.json({
      data: formattedBookings,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / limit),
      },
    });
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
      },
    });

    res.status(201).json(booking);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};
