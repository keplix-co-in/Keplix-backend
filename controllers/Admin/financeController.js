import prisma from "../../util/prisma.js";

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
              select: { name: true }
            },
            vendor_status: true,
            user: {
              select: { 
                vendorProfile: {
                  select: { business_name: true, city: true }
                }
              }
            }
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
    
    const payment = await prisma.payment.update({
      where: { id: Number(id) },
      data: {
        vendorPayoutStatus: "settled",
        updatedAt: new Date()
      }
    });

    res.json({ success: true, message: "Payout marked as settled", payment });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Failed to settle payout" });
  }
};