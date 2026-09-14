import prisma from "../../util/prisma.js";
import Logger from "../../util/logger.js";
import { toCanonicalTime } from "../../util/slots.js";

export const getBookingMetrics = async (req, res) => {
  try {

    const [
      allBookings,
      completedBookings,
      inProgressBookings,
      confirmedBookings,
      cancelledBookings,
      requestedBookings
    ] = await Promise.all([

      prisma.booking.count(),

      prisma.booking.count({
        where: {
          status: {
            in: ["service_completed", "user_confirmed"]
          }
        }
      }),

      prisma.booking.count({
        where: { status: "in_progress" }
      }),

      prisma.booking.count({
        where: { status: "confirmed" }
      }),

      prisma.booking.count({
        where: { status: "cancelled" }
      }),

      prisma.booking.count({
        where: { status: "pending" }
      })

    ]);

    res.json({
      allBookings,
      completedBookings,
      inProgressBookings,
      confirmedBookings,
      cancelledBookings,
      requestedBookings
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Metrics fetch failed" });
  }
};

export const getBookings = async (req, res) => {
  try {

    const { type = "all", page = 1, limit = 10 } = req.query;

    const skip = (page - 1) * limit;

    let filter = {};

    // 🔥 FILTER LOGIC
    if (type === "completed") {
      filter.status = {
        in: ["service_completed", "user_confirmed"]
      };
    }

    else if (type === "inprogress") {
      filter.status = "in_progress";
    }

    else if (type === "confirmed") {
      filter.status = "confirmed";
    }

    else if (type === "cancelled") {
      filter.status = "cancelled";
    }

    else if (type === "requested") {
      filter.status = "pending";
    }

    // 🚀 QUERY
    const bookings = await prisma.booking.findMany({
      where: filter,

      select: {
        id: true,
        status: true,
        booking_date: true,
        booking_time: true,
        createdAt: true,

        user: {
          select: {
            userProfile: {
              select: {
                name: true,
                phone: true
              }
            }
          }
        },

        service: {
          select: {
            name: true,
            vendor: {
              select: {
                vendorProfile: {
                  select: {
                    business_name: true
                  }
                }
              }
            }
          }
        },

        payment: {
          select: {
            amount: true,
            platformFee: true
          }
        }
      },

      orderBy: {
        createdAt: "desc"
      },

      skip: Number(skip),
      take: Number(limit)
    });

    // 🎯 RESPONSE FORMAT
    const formatted = bookings.map(b => ({
      id: b.id,
      customer: b.user?.userProfile?.name || "N/A",
      phone: b.user?.userProfile?.phone || "N/A",
      vendor: b.service?.vendor?.vendorProfile?.business_name || "N/A",
      service: b.service?.name,
      // Found live in the admin panel: the SLOT column rendered
      // "Sat Aug 22 2026 05:30:00 GMT+0530 (India Standard Time) 19:30" --
      // `b.booking_date` is a Prisma DateTime object, and interpolating it
      // directly into a template literal implicitly calls Date.prototype.toString(),
      // which returns that entire verbose string, before booking_time gets
      // appended after it. Only the calendar date was ever wanted here.
      // `booking_time` also gets normalised through toCanonicalTime -- legacy
      // rows still hold 12-hour strings like "2:00 PM", which otherwise sit
      // inconsistently next to canonical "14:00" rows in the same column.
      slot: `${b.booking_date instanceof Date ? b.booking_date.toISOString().slice(0, 10) : b.booking_date} ${toCanonicalTime(b.booking_time) || b.booking_time}`,
      amount: b.payment?.amount || 0,
      fee: b.payment?.platformFee || 0,
      status: b.status,
      createdAt: b.createdAt
    }));

    res.json(formatted);

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Bookings fetch failed" });
  }
};
// @desc    Force-complete a booking without a submitted health sheet — the
//          escape hatch if the mandatory-inspection gate misfires or a
//          garage genuinely cannot submit one (e.g. app issue on their end).
//
//          Safety boundary worth stating explicitly: this sets Booking.status
//          only. It does NOT trigger escrow release — that only happens via
//          services/bookingConfirmationService.confirmBookingAndQueuePayout,
//          which runs off the CUSTOMER'S OWN confirmation
//          (serviceConfirmationController.confirmServiceCompletion), a
//          separate step this endpoint does not touch. So this action is
//          reversible in effect (it unblocks the vendor-side status only)
//          and cannot itself move money.
// @route   POST /admin/bookings/:id/force-complete
export const forceCompleteBooking = async (req, res) => {
  const { reason } = req.body;
  const bookingId = parseInt(req.params.id);

  try {
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    // This wrote service_completed from ANY state, with no guard. That let an
    // already-resolved booking be resurrected: force-completing a CANCELLED
    // booking put it back into a state the customer could then confirm, which
    // queues a vendor payout for a booking that was cancelled (and possibly
    // refunded). 'disputed' is deliberately still allowed -- resolving a dispute
    // in the vendor's favour is a legitimate use of this endpoint.
    const ALREADY_RESOLVED = ["cancelled", "user_confirmed", "completed"];
    if (ALREADY_RESOLVED.includes(booking.status)) {
      return res.status(400).json({
        message: `Cannot force-complete a booking that is already ${booking.status}.`,
      });
    }

    const updated = await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: "service_completed",
        notes: reason
          ? `${booking.notes ? booking.notes + " | " : ""}[Admin force-complete by ${req.user.id}]: ${reason}`
          : booking.notes,
      },
    });

    // Deliberately loud — this is the one path that bypasses a safety gate,
    // and it should be easy to find in logs later.
    Logger.warn(
      `[Admin] Booking ${bookingId} force-completed by admin ${req.user.id} bypassing the health-sheet gate. Reason: ${reason || "(none given)"}`,
    );

    return res.json({ booking: updated });
  } catch (error) {
    Logger.error(`[Admin] forceCompleteBooking failed: ${error.message}`);
    return res.status(500).json({ message: "Server Error" });
  }
};
