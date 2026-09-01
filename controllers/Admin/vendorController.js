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
        email: true,

        vendorProfile: {
          select: {
            business_name: true,
            business_type: true,
            city: true,
            status: true,
            owner_name: true,
            onboarding_completed: true,
            image: true
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

    // Earnings per vendor: sum of Payment.vendorAmount for payouts that have
    // actually settled, same definition the vendor-facing earnings endpoint
    // uses (controllers/vendor/paymentController.js) -- listing "total
    // earnings" as 0 for every vendor here was never a real number, just a
    // hardcoded placeholder.
    // Prisma's groupBy can't aggregate on a nested-relation column
    // (booking.service.vendorId), so the per-vendor total is built by
    // fetching each matching payment's vendorId alongside its amount and
    // summing in JS instead.
    const vendorIds = vendors.map(v => v.id);
    const earningsByVendor = {};
    if (vendorIds.length) {
      const payments = await prisma.payment.findMany({
        where: {
          vendorPayoutStatus: { in: ['paid', 'settled'] },
          booking: { service: { vendorId: { in: vendorIds } } }
        },
        select: {
          vendorAmount: true,
          booking: { select: { service: { select: { vendorId: true } } } }
        }
      });
      for (const p of payments) {
        const vId = p.booking?.service?.vendorId;
        if (vId == null) continue;
        earningsByVendor[vId] = (earningsByVendor[vId] || 0) + Number(p.vendorAmount || 0);
      }
    }

    const formatted = vendors.map(v => ({
      id: v.id,
      vendor: v.vendorProfile?.business_name || "N/A",
      owner: v.vendorProfile?.owner_name || "",
      email: v.email || "",
      profileImage: v.vendorProfile?.image || null,
      category: v.vendorProfile?.business_type || "N/A",
      city: v.vendorProfile?.city || "N/A",
      bookings: v._count.bookings,
      rating: 0,
      status: v.vendorProfile?.status || "pending",
      verified: v.vendorProfile?.onboarding_completed ? "verified" : "basic",
      totalEarnings: earningsByVendor[v.id] || 0
    }));

    res.json(formatted);

  } catch (error) {
    res.status(500).json({ message: "Failed to fetch vendors" });
  }
};