import prisma from "../../util/prisma.js";

export const getFinanceKpis = async (req, res) => {
  try {
    const [
      totalCollected,
      disbursed,
      commission,
      pendingDisbursement,
      refunds,
      failed
    ] = await Promise.all([
      // Total Collected in Escrow
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: { status: "success" }
      }),
      // Disbursed to Vendors
      prisma.payment.aggregate({
        _sum: { vendorAmount: true },
        where: { vendorPayoutStatus: "settled", status: "success" }
      }),
      // Platform Commission
      prisma.payment.aggregate({
        _sum: { platformFee: true },
        where: { status: "success" }
      }),
      // Pending Disbursement
      prisma.payment.aggregate({
        _sum: { vendorAmount: true },
        where: { vendorPayoutStatus: "pending", status: "success" }
      }),
      // Refunds Issued
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: { status: "refunded" }
      }),
      // Failed Payouts
      prisma.payment.aggregate({
        _sum: { vendorAmount: true },
        where: { vendorPayoutStatus: "failed" }
      })
    ]);

    res.json({
      totalCollected: totalCollected._sum.amount || 0,
      disbursed: disbursed._sum.vendorAmount || 0,
      commission: commission._sum.platformFee || 0,
      pendingDisbursement: pendingDisbursement._sum.vendorAmount || 0,
      refunds: refunds._sum.amount || 0,
      failed: failed._sum.vendorAmount || 0
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch finance KPIs" });
  }
};

export const getPendingPayouts = async (req, res) => {
  try {
    const payouts = await prisma.payment.findMany({
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

    res.json(payouts);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch payouts" });
  }
};

export const settlePayout = async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Fetch exact payment and nested vendor to process payout
    const payment = await prisma.payment.findUnique({
      where: { id: Number(id) },
      include: {
        booking: {
          include: {
            service: { include: { vendor: { include: { VendorPayoutAccount: true, vendorProfile: true } } } }
          }
        }
      }
    });

    if (!payment) return res.status(404).json({ success: false, message: "Payment not found" });
    if (payment.vendorPayoutStatus === "settled") return res.status(400).json({ success: false, message: "Already settled!" });

    // Handle Prisma Decimal correctly
    const vendorAmountInRupees = parseFloat(payment.vendorAmount?.toString() || "0");
    if (!vendorAmountInRupees || vendorAmountInRupees <= 0) {
      return res.status(400).json({ success: false, message: "Zero amount or invalid vendor amount" });
    }

    const { RAZORPAYX_KEY_ID, RAZORPAYX_KEY_SECRET, RAZORPAYX_ACCOUNT_NUMBER } = process.env;

    // Only hit gateway if credentials are provided in .env
    let vendorPayoutId = "mock_tx_" + Date.now();
    let isGatewayProcessed = false;

    if (RAZORPAYX_KEY_ID && RAZORPAYX_KEY_SECRET && RAZORPAYX_ACCOUNT_NUMBER) {
      const auth = Buffer.from(`${RAZORPAYX_KEY_ID}:${RAZORPAYX_KEY_SECRET}`).toString("base64");
      const headers = { 
        "Content-Type": "application/json", 
        "Authorization": `Basic ${auth}` 
      };

      const vendorUser = payment.booking?.service?.vendor;
      let payoutAccount = vendorUser?.VendorPayoutAccount;
      
      // Sandbox fallback: auto-provision a Testing Bank Account if Vendor hasn't set it in UI yet
      if (!payoutAccount) {
        // A. Create Razorpay Contact
        let contactReq = await fetch("https://api.razorpay.com/v1/contacts", {
          method: "POST", headers,
          body: JSON.stringify({
            name: vendorUser.vendorProfile?.business_name || "Unknown Business",
            email: vendorUser.email, contact: vendorUser.vendorProfile?.phone || "9999999999",
            type: "vendor", reference_id: `vendor_${vendorUser.id}`
          })
        });
        const contactRes = await contactReq.json();
        if(!contactReq.ok) throw new Error(contactRes.error.description || "Razorpay Contact failed");

        // B. Create Sandbox Test Bank Fund Account (Using mock HDFC IFSC)
        let fundReq = await fetch("https://api.razorpay.com/v1/fund_accounts", {
          method: "POST", headers,
          body: JSON.stringify({
            contact_id: contactRes.id, account_type: "bank_account",
            bank_account: { name: contactRes.name, ifsc: "HDFC0000053", account_number: "765432123456789" }
          })
        });
        const fundRes = await fundReq.json();
        if(!fundReq.ok) throw new Error(fundRes.error.description || "Razorpay Fund Account failed");

        // Save to DB so we don't recreate contacts unnecessarily 
        payoutAccount = await prisma.vendorPayoutAccount.create({
          data: { vendorId: vendorUser.id, contactId: contactRes.id, fundAccountId: fundRes.id }
        });
      }

      // C. Initiate Payout Transfer (IMPS/NEFT/UPI supported by X)
      const payoutReq = await fetch("https://api.razorpay.com/v1/payouts", {
        method: "POST", headers,
        body: JSON.stringify({
          account_number: RAZORPAYX_ACCOUNT_NUMBER,
          fund_account_id: payoutAccount.fundAccountId,
          amount: Math.round(vendorAmountInRupees * 100), // convert to paise
          currency: "INR", mode: "IMPS", purpose: "payout",
          reference_id: `keplix_payout_${payment.id}`,
          narration: `Payout Booking ${payment.bookingId}`
        })
      });
      const payoutRes = await payoutReq.json();
      if (!payoutReq.ok) {
         console.log("Mock Fallback due to Gateway Rejection: ", payoutRes.error?.description);
         return res.status(400).json({ success: false, message: payoutRes.error?.description || "Gateway Payout Failed" });
      } else {
         vendorPayoutId = payoutRes.id;
         isGatewayProcessed = true;
      }
    }

    // Mark DB Settlement as triggered
    const updatedPayment = await prisma.payment.update({
      where: { id: Number(id) },
      data: {
        vendorPayoutStatus: "settled",
        vendorPayoutId: vendorPayoutId,
        updatedAt: new Date()
      }
    });

    res.json({ 
      success: true, 
      message: isGatewayProcessed ? "Razorpay Gateway processed real payout!" : "Mock processed (No Gateway ENV set)", 
      payment: updatedPayment 
    });
  } catch (error) {
    console.error("Payout Gateway Error: ", error);
    res.status(500).json({ success: false, message: error.message || "Failed to settle payout entirely" });
  }
};