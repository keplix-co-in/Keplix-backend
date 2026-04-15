import prisma from '../../util/prisma.js';

export const getVendorMetrics = async (req, res) => {
  try {

    const [
      allVendors,
      activeVendors,
      pendingVendors,
      suspendedVendors,
      uninstalledVendors
    ] = await Promise.all([

      
      prisma.user.count({
        where: { role: "vendor" }
      }),

   
      prisma.user.count({
        where: {
          role: "vendor",
          is_active: true,
          vendorProfile: {
            status: "approved"
          }
        }
      }),

   
      prisma.user.count({
        where: {
          role: "vendor",
          vendorProfile: {
            status: "pending"
          }
        }
      }),

  
      prisma.user.count({
        where: {
          role: "vendor",
          is_active: false
        }
      }),

      
      prisma.user.count({
        where: {
          role: "vendor",
          fcmToken: null,
          pushToken: null
        }
      })

    ]);

    res.json({
      allVendors,
      activeVendors,
      pendingVendors,
      suspendedVendors,
      uninstalledVendors
    });

  } catch (error) {
    res.status(500).json({ message: "Failed to fetch vendor metrics" });
  }
};

export const getVendors = async (req, res) => {
  try {

    const { type = "all", page = 1, limit = 10 } = req.query;

    const skip = (page - 1) * limit;

    let filter = {
      role: "vendor"
    };

    if (type === "active") {
      filter = {
        role: "vendor",
        is_active: true,
        vendorProfile: {
          status: "approved"
        }
      };
    }

    else if (type === "pending") {
      filter = {
        role: "vendor",
        vendorProfile: {
          status: "pending"
        }
      };
    }

    else if (type === "suspended") {
      filter = {
        role: "vendor",
        is_active: false
      };
    }

    else if (type === "uninstalled") {
      filter = {
        role: "vendor",
        fcmToken: null,
        pushToken: null
      };
    }

    const vendors = await prisma.user.findMany({
      where: filter,

      select: {
        id: true,
        is_active: true,

        vendorProfile: {
          select: {
            business_name: true,
            business_type: true,
            city: true,
            status: true
          }
        },

        _count: {
          select: {
            bookings: true
          }
        }
      },

      orderBy: {
        createdAt: "desc"
      },

      skip: Number(skip),
      take: Number(limit)
    });

    const formatted = vendors.map(v => ({
      id: v.id,
      vendor: v.vendorProfile?.business_name || "N/A",
      category: v.vendorProfile?.business_type || "N/A",
      city: v.vendorProfile?.city || "N/A",
      bookings: v._count.bookings,
      rating: 0,
      status: v.vendorProfile?.status || "pending",
      totalEarnings: 0
    }));

    res.json(formatted);

  } catch (error) {
    res.status(500).json({ message: "Failed to fetch vendors" });
  }
};