import prisma from "../../util/prisma.js";

export const getDashboardMetrics = async (req, res) => {
  try {

    const todayStart = new Date();
    todayStart.setHours(0,0,0,0);

    const [
      todayGMV,
      platformRevenue,
      bookingsToday,
      activeVendors,
      newUsersToday,
      pendingPayouts,
      todayWalkInGMV,
      walkInCommissionRevenue
    ] = await Promise.all([

      // GMV (total booking value today)
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: {
          status: "success",
          createdAt: { gte: todayStart }
        }
      }),

      // Platform Revenue
      prisma.payment.aggregate({
        _sum: { platformFee: true },
        where: {
          status: "success"
        }
      }),

      // Bookings Today
      prisma.booking.count({
        where: {
          createdAt: { gte: todayStart }
        }
      }),

      // Active Vendors
      prisma.user.count({
        where: {
          role: "vendor",
          is_active: true,
          vendorProfile: {
            status: "approved"
          }
        }
      }),

      // New Users Today
      prisma.user.count({
        where: {
          createdAt: { gte: todayStart },
          role: "user"
        }
      }),

      // Pending payouts
      prisma.payment.aggregate({
        _sum: { vendorAmount: true },
        where: {
          vendorPayoutStatus: "pending",
          status: "success"
        }
      }),

      // Walk-in GMV today. Walk-in jobs are a second, parallel revenue
      // channel (in-person garage visits, no app booking/Payment row) that
      // was previously invisible to this dashboard entirely -- a vendor
      // routing volume through walk-ins rather than app bookings paid zero
      // platform fee AND showed up nowhere here, with no way to tell the two
      // apart. `status: 'completed'` mirrors Payment's `status: 'success'`.
      prisma.walkInJob.aggregate({
        _sum: { amount_collected: true },
        where: {
          status: "completed",
          createdAt: { gte: todayStart }
        }
      }),

      // Walk-in commission revenue, all-time. `commission_rate`/`commission_amount`
      // default to null for every row today (v1: no commission applied to
      // walk-ins yet, per schema.prisma's own comment) -- this will correctly
      // read as 0 until that's turned on, which is honest, not a bug. Once it
      // is, this line needs no further change.
      prisma.walkInJob.aggregate({
        _sum: { commission_amount: true },
        where: { status: "completed" }
      })

    ]);

    const todayGMVTotal =
      Number(todayGMV._sum.amount || 0) + Number(todayWalkInGMV._sum.amount_collected || 0);
    const platformRevenueTotal =
      Number(platformRevenue._sum.platformFee || 0) + Number(walkInCommissionRevenue._sum.commission_amount || 0);

    res.json({
      todayGMV: todayGMVTotal,
      platformRevenue: platformRevenueTotal,
      bookingsToday,
      activeVendors,
      newUsersToday,
      pendingPayouts: pendingPayouts._sum.vendorAmount || 0,
      // Broken out separately too, so a sudden GMV jump can be traced to
      // which channel actually drove it instead of one opaque total.
      walkInGMVToday: Number(todayWalkInGMV._sum.amount_collected || 0)
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Dashboard metrics failed" });
  }
};

export const getDashboardDetails = async (req, res) => {
  try {

    const { type } = req.query;

    const todayStart = new Date();
    todayStart.setHours(0,0,0,0);

    let data = [];

    // 💰 GMV Details
    if (type === "gmv") {
      data = await prisma.payment.findMany({
        where: {
          status: "success",
          createdAt: { gte: todayStart }
        },
        select: {
          id: true,
          amount: true,
          createdAt: true,
          booking: {
            select: {
              id: true
            }
          }
        }
      });
    }

    // 📦 Bookings Today
    else if (type === "bookings") {
      data = await prisma.booking.findMany({
        where: {
          createdAt: { gte: todayStart }
        },
        select: {
          id: true,
          status: true,
          booking_date: true,
          booking_time: true
        }
      });
    }

    // 👤 New Users
    else if (type === "users") {
      data = await prisma.user.findMany({
        where: {
          createdAt: { gte: todayStart }
        },
        select: {
          id: true,
          email: true,
          createdAt: true
        }
      });
    }

    // 🧑‍💼 Active Vendors
    else if (type === "vendors") {
      data = await prisma.user.findMany({
        where: {
          role: "vendor",
          is_active: true
        },
        select: {
          id: true,
          vendorProfile: {
            select: {
              business_name: true,
              city: true
            }
          }
        }
      });
    }

    // 💸 Platform Revenue
    else if (type === "revenue") {
      data = await prisma.payment.findMany({
        where: {
          status: "success"
        },
        select: {
          id: true,
          platformFee: true,
          createdAt: true
        }
      });
    }

    // ⏳ Pending Payouts
    else if (type === "payouts") {
      data = await prisma.payment.findMany({
        where: {
          vendorPayoutStatus: "pending",
          status: "success"
        },
        select: {
          id: true,
          vendorAmount: true,
          createdAt: true,
          booking: {
            select: {
              id: true,
              service: {
                select: {
                  name: true,
                  vendor: {
                    select: {
                      vendorProfile: {
                        select: { business_name: true, city: true }
                      }
                    }
                  }
                }
              },
              vendor_status: true
            }
          }
        },
        orderBy: {
          createdAt: 'asc'
        }
      });
    }

    res.json(data);

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Dashboard details failed" });
  }
};