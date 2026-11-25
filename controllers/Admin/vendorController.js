import { clampLimit } from "../../util/parsePagination.js"; // Security A-026: list limits capped at 100
import prisma from '../../util/prisma.js';
import Logger from "../../util/logger.js";
import { getOrCreateSubscription } from "../../util/subscription.js";
import { signPrivateUrl } from "../../util/cloudinary.js";
import { computeOnboarding, maskTail } from "../../util/vendorOnboarding.js";
import { parseApprovalsQuery } from "../../validators/Admin/vendorValidator.js";

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
      take: clampLimit(limit)
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
      select: { id: true, status: true, business_name: true },
    });

    if (!profile) {
      return res.status(404).json({ message: "Vendor profile not found" });
    }

    // WHY: owner decision 2026-11-24 -- no vendor goes live with an incomplete
    // onboarding, whatever the admin UI does. Checked before the no-op branch.
    if (status === "approved") {
      const full = await prisma.vendorProfile.findUnique({ where: { userId: vendorId } });
      const docs = await prisma.document.findMany({
        where: { vendorId },
        select: { document_type: true },
      });
      const { complete, missing } = computeOnboarding(full, docs);
      if (!complete) {
        return res.status(400).json({
          code: "ONBOARDING_INCOMPLETE",
          message: "Vendor onboarding is incomplete.",
          missing,
        });
      }
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
      select: { userId: true, status: true, business_name: true },
    });

    // Audit: start the trial clock at approval. A vendor with no subscription row
    // is treated as visible forever (rows are otherwise created lazily by the
    // reminder cron), so create it here. Best-effort: approval already succeeded.
    if (status === "approved") {
      try {
        await getOrCreateSubscription(vendorId, new Date());
      } catch (e) {
        Logger.error(`[Admin] trial row for vendor ${vendorId} failed: ${e.message}`);
      }
    }

    // Loud on purpose: this is the gate between a signup and a business that can
    // take customers' money, so it needs to be searchable in logs afterwards.
    Logger.warn(
      `[Admin] Vendor ${vendorId} (${updated.business_name || "unnamed"}) status ${profile.status} -> ${status} by admin ${req.user?.id}. Reason: ${reason || "(none given)"}`,
    );

    return res.json({ message: `Vendor ${status}.`, vendor: updated });
  } catch (error) {
    Logger.error(`[Admin] setVendorStatus failed: ${error.message}`);
    return res.status(500).json({ message: "Server Error" });
  }
};


/**
 * GET /admin/vendors/:id -- everything onboarding collected, for the admin
 * verification step. Bank/UPI masked to the last 4; document URLs are signed
 * (they are private Cloudinary assets). Read-only; any admin may call it.
 */
export const getVendorDetail = async (req, res) => {
  const vendorId = parseInt(req.params.id, 10);
  if (!Number.isInteger(vendorId)) {
    return res.status(400).json({ message: "Invalid vendor id" });
  }
  try {
    const user = await prisma.user.findFirst({
      where: { id: vendorId, role: "vendor" },
      select: { id: true, email: true, is_verified: true, is_active: true, createdAt: true, vendorProfile: true },
    });
    if (!user || !user.vendorProfile) {
      return res.status(404).json({ message: "Vendor not found" });
    }
    const [documents, servicesCount] = await Promise.all([
      prisma.document.findMany({ where: { vendorId }, orderBy: { createdAt: "desc" } }),
      prisma.service.count({ where: { vendorId } }),
    ]);
    const p = user.vendorProfile;
    const onboarding = computeOnboarding(p, documents);
    return res.json({
      data: {
        account: {
          id: user.id, name: p.owner_name || null, email: user.email, phone: p.phone,
          alternatePhone: p.alternate_phone, emailVerified: !!user.is_verified,
          // No separate phone-verified flag on the schema; see owner items.
          phoneVerified: null, isActive: user.is_active, createdAt: user.createdAt,
          dateOfBirth: p.date_of_birth,
        },
        business: {
          name: p.business_name, type: p.business_type, description: p.description,
          address: p.address, street: p.street, area: p.area, city: p.city, state: p.state,
          pincode: p.pincode, landmark: p.landmark, latitude: p.latitude, longitude: p.longitude,
          operatingHours: p.operating_hours, breaks: p.breaks, holidays: p.holidays,
          image: p.image ? signPrivateUrl(p.image) : null,
          coverImage: p.cover_image ? signPrivateUrl(p.cover_image) : null,
          hasGst: p.has_gst, gstNumber: p.gst_number, taxType: p.tax_type,
        },
        documents: documents.map((d) => ({
          id: d.id, type: d.document_type, status: d.status, createdAt: d.createdAt,
          url: signPrivateUrl(d.file_url),
        })),
        bank: {
          accountHolder: p.bank_account_holder_name,
          accountNumber: maskTail(p.bank_account_number),
          ifsc: p.ifsc_code, upi: maskTail(p.upi_id),
        },
        servicesCount,
        status: p.status,
        onboarding,
      },
    });
  } catch (error) {
    Logger.error(`[Admin] getVendorDetail failed: ${error.message}`);
    return res.status(500).json({ message: "Server Error" });
  }
};


// Only the columns computeOnboarding reads -- keeps the approvals list cheap.
const APPROVAL_PROFILE_SELECT = {
  business_name: true, owner_name: true, phone: true, address: true, street: true, city: true,
  pincode: true, latitude: true, longitude: true, operating_hours: true,
  bank_account_number: true, ifsc_code: true, upi_id: true, status: true,
};
// Hard ceiling when the onboarding filter forces an in-memory pass.
const APPROVAL_SCAN_CAP = 5000;

/**
 * GET /admin/vendors/approvals -- newest-first vendor list with server-side
 * filters (status, from/to joined date, city, onboarding, q search) and paging.
 * One query: profile + document types are joined in, so no N+1. "Onboarding
 * complete" is derived in JS (computeOnboarding is the single source of truth),
 * so that filter scans matching rows and pages in memory; otherwise the DB pages.
 * Never logs personal data.
 */
export const listVendorApprovals = async (req, res) => {
  const parsed = parseApprovalsQuery(req.query);
  if (parsed.error) return res.status(400).json({ message: parsed.error });
  const { status, page, limit, from, to, onboarding, city, q } = parsed.value;

  const profileWhere = {};
  if (status !== "all") profileWhere.status = status;
  if (city) profileWhere.city = { equals: city, mode: "insensitive" };
  const where = { role: "vendor", vendorProfile: { is: profileWhere } };
  if (from || to) where.createdAt = { ...(from && { gte: from }), ...(to && { lte: to }) };
  if (q) {
    const c = { contains: q, mode: "insensitive" };
    where.OR = [
      { email: c },
      { vendorProfile: { is: { business_name: c } } },
      { vendorProfile: { is: { owner_name: c } } },
      { vendorProfile: { is: { phone: c } } },
    ];
  }

  const select = {
    id: true, email: true, createdAt: true,
    vendorProfile: { select: APPROVAL_PROFILE_SELECT },
    documents: { select: { document_type: true } },
  };
  const orderBy = [{ createdAt: "desc" }, { id: "desc" }];
  const shape = (u) => {
    const ob = computeOnboarding(u.vendorProfile, u.documents);
    return {
      id: u.id,
      business: u.vendorProfile?.business_name || "",
      owner: u.vendorProfile?.owner_name || "",
      email: u.email || "",
      phone: u.vendorProfile?.phone || "",
      city: u.vendorProfile?.city || "",
      joinedAt: u.createdAt,
      status: u.vendorProfile?.status || "pending",
      documentsCount: u.documents.length,
      onboardingComplete: ob.complete,
      missingCount: ob.missing.length,
    };
  };

  try {
    let rows; let total;
    if (onboarding) {
      const all = (await prisma.user.findMany({ where, select, orderBy, take: APPROVAL_SCAN_CAP })).map(shape)
        .filter((r) => (onboarding === "complete" ? r.onboardingComplete : !r.onboardingComplete));
      total = all.length;
      rows = all.slice((page - 1) * limit, page * limit);
    } else {
      const [count, users] = await Promise.all([
        prisma.user.count({ where }),
        prisma.user.findMany({ where, select, orderBy, skip: (page - 1) * limit, take: limit }),
      ]);
      total = count;
      rows = users.map(shape);
    }
    return res.json({
      data: rows,
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    Logger.error(`[Admin] listVendorApprovals failed: ${error.message}`);
    return res.status(500).json({ message: "Server Error" });
  }
};
