import prisma from "../../util/prisma.js";

export const getBookingMetrics = async (req, res) => {
  try {

    const [
      allBookings,
      completedBookings,
      inProgressBookings,
      confirmedBookings,
      cancelledBookings,
      requestedBookings
    ] = await Promise.all([

      prisma.booking.count(),

      prisma.booking.count({
        where: {
          status: {
            in: ["service_completed", "user_confirmed"]
          }
        }
      }),

      prisma.booking.count({
        where: { status: "in_progress" }
      }),

      prisma.booking.count({
        where: { status: "confirmed" }
      }),

      prisma.booking.count({
        where: { status: "cancelled" }
      }),

      prisma.booking.count({
        where: { status: "pending" }
      })

    ]);

    res.json({
      allBookings,
      completedBookings,
      inProgressBookings,
      confirmedBookings,
      cancelledBookings,
      requestedBookings
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Metrics fetch failed" });
  }
};

export const getBookings = async (req, res) => {
  try {

    const { type = "all", page = 1, limit = 10 } = req.query;

    const skip = (page - 1) * limit;

    let filter = {};

    // 🔥 FILTER LOGIC
    if (type === "completed") {
      filter.status = {
        in: ["service_completed", "user_confirmed"]
      };
    }

    else if (type === "inprogress") {
      filter.status = "in_progress";
    }

    else if (type === "confirmed") {
      filter.status = "confirmed";
    }

    else if (type === "cancelled") {
      filter.status = "cancelled";
    }

    else if (type === "requested") {
      filter.status = "pending";
    }

    // 🚀 QUERY
    const bookings = await prisma.booking.findMany({
      where: filter,

      select: {
        id: true,
        status: true,
        booking_date: true,
        booking_time: true,
        createdAt: true,

        user: {
          select: {
            userProfile: {
              select: {
                name: true,
                phone: true
              }
            }
          }
        },

        service: {
          select: {
            name: true,
            vendor: {
              select: {
                vendorProfile: {
                  select: {
                    business_name: true
                  }
                }
              }
            }
          }
        },

        payment: {
          select: {
            amount: true,
            platformFee: true
          }
        }
      },

      orderBy: {
        createdAt: "desc"
      },

      skip: Number(skip),
      take: Number(limit)
    });

    // 🎯 RESPONSE FORMAT
    const formatted = bookings.map(b => ({
      id: b.id,
      customer: b.user?.userProfile?.name || "N/A",
      phone: b.user?.userProfile?.phone || "N/A",
      vendor: b.service?.vendor?.vendorProfile?.business_name || "N/A",
      service: b.service?.name,
      slot: `${b.booking_date} ${b.booking_time}`,
      amount: b.payment?.amount || 0,
      fee: b.payment?.platformFee || 0,
      status: b.status,
      createdAt: b.createdAt
    }));

    res.json(formatted);

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Bookings fetch failed" });
  }
};