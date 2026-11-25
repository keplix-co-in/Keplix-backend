import Razorpay from "razorpay";
import prisma from "../../util/prisma.js";
import { sendError } from "../../util/apiError.js";



// Security A-019: no placeholder-key fallbacks. A missing key used to build a
// client with a dummy secret, and verifyVendorPayment's HMAC would then be
// keyed by whatever was in the env (possibly undefined). The client is built
// on first use and a missing key is a clean 503 instead.
let razorpayClient = null;
export const getRazorpay = () => {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) return null;
  if (!razorpayClient) razorpayClient = new Razorpay({ key_id, key_secret });
  return razorpayClient;
};


// Audit: both retired. They took a client-chosen amount and wrote Payment rows
// with platformFee=amount, inflating revenue KPIs. Vendors pay through the
// subscription flow (/subscriptions/order + /verify). Routes stay so shipped
// builds get a clear 410 instead of a 404. Old code lives in git history.
const useSubscriptions = (res) =>
  sendError(res, 410, "USE_SUBSCRIPTIONS", "This payment endpoint is closed. Please pay for your plan from the Subscription screen.");

export const createVendorPaymentOrder = async (req, res) => useSubscriptions(res);
export const verifyVendorPayment = async (req, res) => useSubscriptions(res);

/**
 * @desc    Get Vendor Payments (what vendor paid to Keplix)
 * @route   GET /service_api/vendor/:vendor_id/payments
 */
export const getVendorPayments = async (req, res) => {
  try {
    const vendorId = Number(req.params.vendor_id);

    // vendorId from the URL was previously parsed but never applied to the
    // query, so this returned every vendor's Keplix-payment rows to any
    // authenticated caller who knew the route shape. As a stopgap this now at
    // least requires the caller to BE the vendor named in the URL — but the
    // Payment rows created by verifyVendorPayment carry no vendorId column,
    // so the query itself still cannot be scoped to a single vendor.
    // FOLLOW-UP (Phase 2): add a vendorId column to Payment (or a join table)
    // for vendor->Keplix payments so this can filter at the query level
    // instead of only gating on the URL parameter.
    if (!req.user || req.user.id !== vendorId) {
      return res.status(403).json({ message: "Not authorized to view these payments" });
    }

    const payments = await prisma.payment.findMany({
      where: {
        // Security A-018: scoped to the caller. Rows from before Payment.vendorId
        // existed have vendorId null and no longer appear (they can't be
        // attributed to a vendor safely).
        vendorId,
        method: { in: ["razorpay", "stripe"] },
        vendorPayoutStatus: "not_applicable",
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(payments);
  } catch (error) {
    console.error("Get vendor payments error:", error);
    res.status(500).json({ message: "Failed to fetch vendor payments" });
  }
};

/**
 * @desc    Get Vendor Earnings (from user bookings)
 * @route   GET /service_api/vendor/:vendor_id/earning
 */
export const getVendorEarnings = async (req, res) => {
  try {
    const vendorId = Number(req.params.vendor_id);

    // Ownership must be enforced against the authenticated caller, not the
    // URL param — mirrors the fix in getVendorPayments above.
    if (!req.user || req.user.id !== vendorId) {
      return res.status(403).json({ message: "Not authorized to view these earnings" });
    }

    const now = new Date();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const startOfWeek = new Date();
    const day = startOfWeek.getDay();
    const diff = startOfWeek.getDate() - day + (day === 0 ? -6 : 1);
    startOfWeek.setDate(diff);
    startOfWeek.setHours(0, 0, 0, 0);

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    // DEV-23: growth compares month-to-date with the SAME stretch of last month
    // (1st .. same day/time), so early in the month it isn't "2 days vs 30".
    // Day clamped so e.g. 31 Mar compares with 28/29 Feb, not 2-3 Mar.
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const daysInLastMonth = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    const sameTimeLastMonth = new Date(startOfLastMonth);
    sameTimeLastMonth.setDate(Math.min(now.getDate(), daysInLastMonth));
    sameTimeLastMonth.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());

      const baseWhere = {
        booking: {
          status: { notIn: ['cancelled', 'canceled'] },
          service: {
            vendorId,
          },
        },
      };

      const pendingWhere = {
        booking: {
          status: { notIn: ['cancelled', 'canceled'] },
          service: {
            vendorId,
          },
        },
      };      // DEV-23 review: growth counts EARNED money on both sides (not only
      // paid/settled), or recent unpaid-out payments make growth read low.
      const earnedWhere = {
        ...baseWhere,
        status: 'success',
        vendorPayoutStatus: { in: ['pending', 'processing', 'paid', 'settled'] },
      };
      const [total, todayData, weekData, monthData, pendingData, lastMonthData, monthEarnedData] = await Promise.all([
        prisma.payment.aggregate({
          _sum: { vendorAmount: true },
          where: {
            ...baseWhere,
            vendorPayoutStatus: { in: ['paid', 'settled'] },
          },
        }),

        prisma.payment.aggregate({
          _sum: { vendorAmount: true },
          where: {
            ...baseWhere,
            vendorPayoutStatus: { in: ['paid', 'settled'] },
            createdAt: { gte: today },
          },
        }),

        prisma.payment.aggregate({
          _sum: { vendorAmount: true },
          where: {
            ...baseWhere,
            vendorPayoutStatus: { in: ['paid', 'settled'] },
            createdAt: { gte: startOfWeek },
          },
        }),

        prisma.payment.aggregate({
          _sum: { vendorAmount: true },
          where: {
            ...baseWhere,
            vendorPayoutStatus: { in: ['paid', 'settled'] },
            createdAt: { gte: startOfMonth },
          },
        }),

        prisma.payment.aggregate({
          _sum: { vendorAmount: true },
          where: {
            ...pendingWhere,
            vendorPayoutStatus: "pending",
          },
        }),

        prisma.payment.aggregate({
          _sum: { vendorAmount: true },
          where: { ...earnedWhere, createdAt: { gte: startOfLastMonth, lt: sameTimeLastMonth } },
        }),

        prisma.payment.aggregate({
          _sum: { vendorAmount: true },
          where: { ...earnedWhere, createdAt: { gte: startOfMonth } },
        }),
      ]);

    const monthEarnings = monthData._sum?.vendorAmount ? Number(monthData._sum.vendorAmount) : 0;
    const monthEarned = monthEarnedData?._sum?.vendorAmount ? Number(monthEarnedData._sum.vendorAmount) : 0;
    const lastMonthEarnings = lastMonthData?._sum?.vendorAmount ? Number(lastMonthData._sum.vendorAmount) : 0;
    // No baseline last month: report 0, not a fake +100% / Infinity.
    const growthPercentage = lastMonthEarnings > 0
      ? Math.round(((monthEarned - lastMonthEarnings) / lastMonthEarnings) * 1000) / 10
      : 0;
    res.json({
      today_earnings: todayData._sum?.vendorAmount ? Number(todayData._sum.vendorAmount) : 0,
      week_earnings: weekData._sum?.vendorAmount ? Number(weekData._sum.vendorAmount) : 0,
      month_earnings: monthEarnings,
      total_earnings: total._sum?.vendorAmount ? Number(total._sum.vendorAmount) : 0,
      pending_earnings: pendingData._sum?.vendorAmount ? Number(pendingData._sum.vendorAmount) : 0,
      growth_percentage: growthPercentage,
    });
  } catch (error) {
    console.error("Vendor earnings error:", error);
    res.status(500).json({ message: "Failed to fetch vendor earnings" });
  }
};




