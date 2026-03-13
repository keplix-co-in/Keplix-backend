import prisma from "../../util/prisma.js";

export const getBookingCounts = async (req, res) => {
  try {
    const last30Days = new Date();
    last30Days.setDate(last30Days.getDate() - 30);

    const [
      totalBookings,
      completedBookings,
      inprogressBookings,
      cancelledBookings,
      recentBookings,
    ] = await Promise.all([
      // total bookings
      prisma.booking.count(),

      // completed bookings
      prisma.booking.count({
        where: {
          status: "service_completed",
        },
      }),

      // in progress bookings
      prisma.booking.count({
        where: {
          status: "in-progress",
        },
      }),

      // cancelled bookings
      prisma.booking.count({
        where: {
          status: "cancelled",
        },
      }),

      // recent last 30 bookings
      prisma.booking.count({
        where: {
          createdAt: {
            gte: last30Days,
          },
        },
      }),
    ]);

    res.json({
      totalBookings,
      completedBookings,
      inprogressBookings,
      cancelledBookings,
      recentBookings,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ messages: "Failed to fetch booking data" });
  }
};

export const getCardsBookingsData = async (req, res) => {
  try {
    const { type } = req.query;

    const last30Days = new Date();
    last30Days.setDate(last30Days.getDate() - 30);

    let filter = {};

    if (type === "total") {
      filter.status = {
        in: [
          "service_completed",
          "confirmed",
          "in-progress",
          "cancelled",
          "last30Days",
          "pending",
          "refunded",
          "user_confirmed"
        ],
      };
    }

    if (type === "completed") {
      filter.status = {
        in: ["service_completed"]
      };
    }

    if (type === "inprogress") {
      filter.status = {
        in: ["in-progress"]
      };
    }

    if (type === "cancelled") {
      filter.status = {
        in: ["cancelled"]
      };
    }

    if (type === "last30Days") {
      filter.createdAt = {
        gte:last30Days,
      };
    };



    const bookings = await prisma.booking.findMany({
      where: filter,
      include:{
        user:{
          select:{
            id: true,
            email: true
          }
        },

        service:{
          select:{
            id: true,
            price: true
          }
        }
      },
      orderBy:{
        createdAt: "desc"
      }
    });

    res.json(bookings);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to fetch booking data",
    })
  }
};
