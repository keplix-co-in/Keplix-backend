import prisma from "../../util/prisma.js";

export const getDashboardData = async (req, res) => {
  try {
    const last30Days = new Date();
    last30Days.setDate(last30Days.getDate() - 30);

    const [activeBookings, activeVendors, newUsersLast30Days] =
      await Promise.all([
        // active bookings
        prisma.booking.count({
          where: {
            status: {
              in: ["pending", "confirmed", "in_progress"],
            },
          },
        }),

        // active vendors
        prisma.user.count({
          where: {
            role: "vendor",
            is_active: true,
            vendorProfile: {
              status: "approved",
            },
          },
        }),

        // new users in last 30 days
        prisma.user.count({
          where: {
            role: "user",
            createdAt: {
              gte: last30Days,
            },
          },
        }),
      ]);

    res.json({
      activeBookings,
      activeVendors,
      newUsersLast30Days,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

export const getDashBoardRevenue = async (req, res) => {
  try {
    const totalRevenue = await prisma.payment.aggregate({
      _sum: {
        amount: true,
      },
      where: {
        status: "success",
      },
    });

    res.json({
      totalRevenue: totalRevenue._sum.amount || 0,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch revenue data" });
  }
};
