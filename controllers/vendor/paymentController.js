import Razorpay from "razorpay";
import crypto from "crypto";
import prisma from "../../util/prisma.js";



const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || "rzp_test_placeholder",
  key_secret: process.env.RAZORPAY_KEY_SECRET || "secret_placeholder",
});


/**
 * @desc    Create Vendor Payment Order (Subscription / Ads / Promotion)
 * @route   POST /service_api/vendor/payments/order/create
 * Vendor â†’ Keplix
 */
export const createVendorPaymentOrder = async (req, res) => {
  try {
    const { amount, currency = "INR", gateway } = req.body;

    if (!amount) {
      return res.status(400).json({ message: "Amount is required" });
    }

    // Partial mitigation, not a fix -- see keplix-backend/prisma's audit note
    // and TODO.md. There is no Subscription/Plan/Invoice model anywhere in
    // schema.prisma for this endpoint to derive a price FROM, and the vendor
    // app's own call site (Payment4.jsx) sends a hardcoded placeholder amount
    // with a comment admitting the real pricing concept was never wired up.
    // A vendor can therefore still set their own price for whatever this
    // endpoint is charging them for -- that requires a product decision
    // (real subscription/ad-rate pricing data) this fix cannot invent. What
    // IS safe to add without guessing at business data: reject amounts
    // outside a sane range, so a typo or a trivially scripted request can't
    // create a ₹0.01 "payment" or a wildly oversized one against a live
    // payment gateway.
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount < 1 || numericAmount > 100000) {
      return res.status(400).json({ message: "Amount must be between ₹1 and ₹1,00,000" });
    }

    if (gateway === "stripe") {
      return res.status(400).json({ message: "Stripe is not supported. Use gateway: 'razorpay'." });
    }

    // RAZORPAY (default)
    const order = await razorpay.orders.create({
      amount: Math.round(numericAmount * 100),
      currency,
      receipt: `vendor_order_${Date.now()}`,
      notes: {
        vendorId: req.user.id,
        type: "vendor_payment",
      },
    });

    return res.json({
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      gateway: "razorpay",
      key_id: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error("Vendor Payment Order Error:", error);
    res.status(500).json({
      message: "Vendor payment order creation failed",
      error: error.message,
    });
  }
};

/**
 * @desc    Verify Vendor Payment
 * @route   POST /service_api/vendor/payments/verify
 */
export const verifyVendorPayment = async (req, res) => {
  try {
    const {
      orderId,
      paymentId,
      signature,
      amount,
      currency = "INR",
      gateway,
    } = req.body;

    // ---------------- RAZORPAY VERIFY ----------------
    // Any gateway value other than "razorpay" previously skipped signature
    // verification entirely and still recorded a "success" payment with a
    // client-chosen amount — this is Keplix's own revenue (vendor paying
    // Keplix for subscription/ads), so an unverified request here was a
    // direct way to fabricate platform revenue records. Only razorpay is
    // accepted; anything else is rejected instead of silently trusted.
    if (gateway !== "razorpay") {
      return res.status(400).json({ message: "Unsupported or missing gateway" });
    }

    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({ message: "orderId, paymentId and signature are required" });
    }

    const body = orderId + "|" + paymentId;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    const expectedBuf = Buffer.from(expectedSignature, "utf8");
    const signatureBuf = Buffer.from(String(signature), "utf8");
    const signatureValid =
      expectedBuf.length === signatureBuf.length &&
      crypto.timingSafeEqual(expectedBuf, signatureBuf);

    if (!signatureValid) {
      return res.status(400).json({ message: "Invalid Razorpay signature" });
    }

    // Fetch the Razorpay order to get the authoritative amount rather than
    // trusting whatever the client sends back at verify time.
    const order = await razorpay.orders.fetch(orderId);
    const verifiedAmount = order.amount / 100; // paise -> rupees

    // ---------------- SAVE PAYMENT ----------------

    await prisma.payment.create({
      data: {
        amount: verifiedAmount,
        currency,
        status: "success",
        method: gateway,
        transactionId: paymentId,
        vendorPayoutStatus: "not_applicable", // IMPORTANT
        platformFee: verifiedAmount, // full amount is Keplix earning
        vendorAmount: 0,
      },
    });

    res.json({
      success: true,
      message: "Vendor payment verified successfully",
    });
  } catch (error) {
    console.error("Vendor Payment Verify Error:", error);
    res.status(500).json({
      message: "Vendor payment verification failed",
      error: error.message,
    });
  }
};

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
      };      const [total, todayData, weekData, monthData, pendingData] = await Promise.all([
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
      ]);    res.json({
      today_earnings: todayData._sum?.vendorAmount ? Number(todayData._sum.vendorAmount) : 0,
      week_earnings: weekData._sum?.vendorAmount ? Number(weekData._sum.vendorAmount) : 0,
      month_earnings: monthData._sum?.vendorAmount ? Number(monthData._sum.vendorAmount) : 0,
      total_earnings: total._sum?.vendorAmount ? Number(total._sum.vendorAmount) : 0,
      pending_earnings: pendingData._sum?.vendorAmount ? Number(pendingData._sum.vendorAmount) : 0,
      growth_percentage: 0,
    });
  } catch (error) {
    console.error("Vendor earnings error:", error);
    res.status(500).json({ message: "Failed to fetch vendor earnings" });
  }
};




