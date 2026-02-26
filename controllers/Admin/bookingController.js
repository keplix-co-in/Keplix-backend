import prisma from "../../util/prisma.js";

export const getBookingData = async (req,res) => {
  try {
    const last30Days = new Date();
    last30Days.setDate(last30Days.getDate() - 30);

    const [totalBookings, completedBookings, inprogressBookings, cancelledBookings, recentBookings] = await Promise.all([


      // total bookings
      prisma.booking.count(),

      // completed bookings
      prisma.booking.count({
        where:{
          status: "service_completed"
        }
      }),


      // in progress bookings
      prisma.booking.count({
        where:{
          status:"in-progress"
        }
      }),


      // cancelled bookings
      prisma.booking.count({
        where:{
          status: "cancelled"
        }
      }),


      // recent last 30 bookings
      prisma.booking.count({
        where:{
          createdAt:{
            gte: last30Days
          }
        }
      })
    ])

    res.json({
      totalBookings,
      completedBookings,
      inprogressBookings,
      cancelledBookings,
      recentBookings
    })
    
  } catch (error) {
    console.error(error);
    res.status(500).json({messages: "Failed to fetch booking data"});
    
  }
}