import prisma from '../../util/prisma.js';
import Logger from "../../util/logger.js";

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


/**
 * Approve, reject or suspend a vendor.
 *
 * This endpoint did not exist. VendorProfile.status defaulted to "pending" and
 * NOTHING in the codebase ever wrote it -- "approved" appeared only in admin READ
 * queries. Three things followed:
 *
 *   - no verification gated a vendor from listing services or taking money;
 *   - searchVendorsByLocation filters `WHERE status = 'approved'`, so the nearby
 *     search could never return a single row;
 *   - the admin "approved vendors" KPI was permanently zero.
 *
 * Statuses are the ones the existing read queries already look for
 * (Admin/vendorController.js getVendors, dashBoardController.js), so adding the
 * write makes those reports start working rather than introducing a new vocabulary.
 */
export const setVendorStatus = async (req, res) => {
  const vendorId = parseInt(req.params.id, 10);
  const { status, reason } = req.body;

  if (!Number.isInteger(vendorId)) {
    return res.status(400).json({ message: "Invalid vendor id" });
  }

  try {
    const profile = await prisma.vendorProfile.findUnique({
      where: { userId: vendorId },
      select: { id: true, status: true, shop_name: true },
    });

    if (!profile) {
      return res.status(404).json({ message: "Vendor profile not found" });
    }

    if (profile.status === status) {
      return res.status(200).json({
        message: `Vendor is already ${status}.`,
        vendor: { id: vendorId, status },
      });
    }

    const updated = await prisma.vendorProfile.update({
      where: { userId: vendorId },
      data: { status },
      select: { userId: true, status: true, shop_name: true },
    });

    // Loud on purpose: this is the gate between a signup and a business that can
    // take customers' money, so it needs to be searchable in logs afterwards.
    Logger.warn(
      `[Admin] Vendor ${vendorId} (${updated.shop_name || "unnamed"}) status ${profile.status} -> ${status} by admin ${req.user?.id}. Reason: ${reason || "(none given)"}`,
    );

    return res.json({ message: `Vendor ${status}.`, vendor: updated });
  } catch (error) {
    Logger.error(`[Admin] setVendorStatus failed: ${error.message}`);
    return res.status(500).json({ message: "Server Error" });
  }
};
