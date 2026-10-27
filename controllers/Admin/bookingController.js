import prisma from "../../util/prisma.js";
import Logger from "../../util/logger.js";
import { toCanonicalTime } from "../../util/slots.js";
import { addNotificationJob } from "../../queues/notificationQueue.js";
import { renderNotification, NOTIFICATION_TYPES } from "../../util/notificationTemplates.js";
import { SETTLED_STATUSES } from "../../util/refundView.js";
import { parseIdParam } from "../../util/parseIdParam.js";

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

// `?type=` value -> Prisma where-clause for the admin bookings list.
//
// Exported for tests/regressions/adminBookingsFilter.test.js. The admin panel
// (kepix-admin src/data/config.js bookingFilters) sends every key here. This
// used to recognise only completed/inprogress/confirmed/cancelled/requested,
// and ANY other value fell through to an empty filter, so choosing "Disputed"
// or "Refunded" silently listed every booking on the platform -- an admin
// could believe there were hundreds of disputes. Unknown values are now a 400
// (see getBookings), never "all".
export const ADMIN_BOOKING_FILTERS = {
  all: {},
  pending: { status: "pending" },
  // Older alias for pending, kept for any cached admin build still sending it.
  requested: { status: "pending" },
  confirmed: { status: "confirmed" },
  in_progress: { status: "in_progress" },
  // The admin panel sends the un-underscored spelling; both are accepted.
  inprogress: { status: "in_progress" },
  // Done by the workshop, waiting on the customer's confirm-or-dispute.
  service_completed: { status: "service_completed" },
  // Unchanged meaning: work done, whether or not the customer has confirmed
  // yet. "completed" itself is included because legacy rows still hold it
  // (vendor app versions that sent 'completed' wrote it verbatim before the
  // backend mapped it to service_completed).
  completed: { status: { in: ["service_completed", "user_confirmed", "completed"] } },
  disputed: { status: "disputed" },
  cancelled: { status: "cancelled" },
  // A workshop declining the request is a vendor_status, not a status: the
  // booking itself is written as 'cancelled' (respondToServiceRequest).
  rejected: { vendor_status: "rejected" },
  // Money actually went back. Same definition as the customer's refund view
  // (util/refundView.js SETTLED_STATUSES), plus Payment.status 'refunded',
  // which refundService writes once the whole amount has been returned.
  refunded: {
    payment: {
      is: {
        OR: [
          { status: "refunded" },
          { refunds: { some: { status: { in: SETTLED_STATUSES } } } },
        ],
      },
    },
  },
};

// Same collapse util/refundView.js applies for customers, minus its
// "payment must still be success" gate (a fully refunded payment is
// 'refunded', which is exactly the case an admin needs to see). null means no
// refund has been attempted.
const adminRefundStatus = (refunds) => {
  if (!Array.isArray(refunds) || refunds.length === 0) return null;
  const live = refunds.filter((r) => r.status !== "gateway_failed");
  if (live.length === 0) return "failed";
  return live.every((r) => SETTLED_STATUSES.includes(r.status)) ? "completed" : "processing";
};

export const getBookings = async (req, res) => {
  try {

    const { type = "all", page = 1, limit = 10 } = req.query;

    const skip = (page - 1) * limit;

    // Own-property lookup so "constructor"/"__proto__" can't match.
    if (!Object.prototype.hasOwnProperty.call(ADMIN_BOOKING_FILTERS, type)) {
      return res.status(400).json({
        message: `Unknown booking filter: ${String(type)}`,
        allowed: Object.keys(ADMIN_BOOKING_FILTERS),
      });
    }
    const filter = ADMIN_BOOKING_FILTERS[type];

    // 🚀 QUERY
    const bookings = await prisma.booking.findMany({
      where: filter,

      select: {
        id: true,
        status: true,
        vendor_status: true,
        booking_date: true,
        booking_time: true,
        createdAt: true,
        // Shown on the admin booking card: why the customer disputed, why
        // the workshop declined, and when the confirm-or-dispute window
        // started. A select list drops anything not named, so these have to
        // be listed explicitly.
        dispute_reason: true,
        disputed_at: true,
        vendor_reject_reason: true,
        service_completed_at: true,

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
            // id + status: the admin card's Refund action posts to
            // /admin/finance/payments/:id/refund, which only accepts a
            // 'success' payment. Without the id the action had nothing to
            // call.
            id: true,
            status: true,
            amount: true,
            platformFee: true,
            refunds: { select: { status: true } },
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
      vendor_status: b.vendor_status,
      createdAt: b.createdAt,
      dispute_reason: b.dispute_reason,
      disputed_at: b.disputed_at,
      vendor_reject_reason: b.vendor_reject_reason,
      service_completed_at: b.service_completed_at,
      // null when no payment exists, so the panel can tell "unpaid" from
      // "payment details missing".
      paymentId: b.payment?.id ?? null,
      payment: b.payment
        ? { id: b.payment.id, status: b.payment.status, refundStatus: adminRefundStatus(b.payment.refunds) }
        : null,
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
  // A non-numeric id used to reach Prisma as NaN and come back as a 500.
  const bookingId = parseIdParam(req.params.id);
  if (bookingId === null) {
    return res.status(400).json({ message: "Invalid booking id" });
  }

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

    // Guarded: the ALREADY_RESOLVED check above was a pre-read, and a
    // customer confirmation or cancellation can commit in between. Writing
    // unconditionally would then drag a user_confirmed/cancelled booking back
    // to service_completed -- the exact resurrection the check exists to stop.
    //
    // service_completed_at is explicitly CLEARED, not just left alone. That
    // column starts the auto-confirm window (util/bookingStatusManager.js),
    // and auto-confirm releases the payout. The header above promises this
    // endpoint "cannot itself move money"; a null column keeps that true --
    // the auto-confirm cron skips rows with no service_completed_at, so a
    // force-completed booking still needs the customer's own confirmation.
    // Merely not setting it was not enough (review 2026-10-20): a booking the
    // vendor marked service_completed and the customer then DISPUTED still
    // carries the vendor's old timestamp, which is long past the 48h window,
    // so force-completing it out of 'disputed' made it auto-confirm -- and
    // pay out -- within ten minutes, over the customer's dispute.
    const { count } = await prisma.booking.updateMany({
      where: { id: bookingId, status: { notIn: ALREADY_RESOLVED } },
      data: {
        status: "service_completed",
        service_completed_at: null,
        notes: reason
          ? `${booking.notes ? booking.notes + " | " : ""}[Admin force-complete by ${req.user.id}]: ${reason}`
          : booking.notes,
      },
    });
    if (count === 0) {
      return res.status(409).json({
        message: "This booking changed status before it could be force-completed. Reload and try again.",
      });
    }
    const updated = await prisma.booking.findUnique({ where: { id: bookingId } });

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

// @desc    Resolve a disputed booking in the CUSTOMER's favour -- the
//          counterpart forceCompleteBooking above never had (audit #76).
//          forceCompleteBooking resolves a dispute for the vendor (moves it
//          on to service_completed, eligible for customer confirmation and
//          payout); this is the other outcome, and there was previously no
//          way to formally close a dispute that way at all.
//
//          Deliberately does NOT call the payment gateway itself. It only
//          transitions the booking to 'cancelled' (freeing the vendor's slot,
//          same as any other cancellation) and notifies both sides. Issuing
//          the actual refund is a separate action against the existing,
//          already-hardened /admin/finance/payments/:id/refund endpoint --
//          this keeps the one code path that talks to Razorpay for a refund
//          exactly where it already is (services/refundService.js), rather
//          than adding a second, less-tested one here.
// @route   POST /admin/bookings/:id/dispute/resolve
export const resolveDisputeForCustomer = async (req, res) => {
  const { reason } = req.body;
  // A non-numeric id used to reach Prisma as NaN and come back as a 500.
  const bookingId = parseIdParam(req.params.id);
  if (bookingId === null) {
    return res.status(400).json({ message: "Invalid booking id" });
  }

  if (!reason || reason.trim().length < 10) {
    return res.status(400).json({ message: "Please provide a detailed reason (minimum 10 characters)" });
  }

  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { service: { select: { vendorId: true, name: true } } },
    });
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    if (booking.status !== "disputed") {
      return res.status(400).json({
        message: `Cannot resolve a dispute on a booking that is not disputed (current status: ${booking.status}).`,
      });
    }

    // Guarded on 'disputed': two admins resolving the same dispute (one for
    // the vendor via force-complete, one here) must not both win. Whichever
    // write lands second sees count 0.
    const { count } = await prisma.booking.updateMany({
      where: { id: bookingId, status: "disputed" },
      data: {
        status: "cancelled",
        notes: `${booking.notes ? booking.notes + " | " : ""}[Admin dispute resolved for customer by ${req.user.id}]: ${reason}`,
      },
    });
    if (count === 0) {
      return res.status(409).json({
        message: "This dispute was resolved or changed before your update. Reload and try again.",
      });
    }
    const updated = await prisma.booking.findUnique({ where: { id: bookingId } });

    Logger.warn(
      `[Admin] Dispute for booking ${bookingId} resolved in the customer's favour by admin ${req.user.id}. Reason: ${reason}. A refund must still be issued separately via /admin/finance/payments/:id/refund.`,
    );

    try {
      const customerNotif = renderNotification(NOTIFICATION_TYPES.DISPUTE_RESOLVED_CUSTOMER, {
        serviceName: booking.service?.name,
        bookingId,
      });
      await addNotificationJob({
        type: customerNotif.type,
        recipientId: booking.userId,
        title: customerNotif.title,
        body: customerNotif.body,
        metadata: { type: customerNotif.type, data: customerNotif.data, bookingId },
        socketEvent: "dispute_resolved",
        socketData: { bookingId, resolution: "customer" },
      });

      if (booking.service?.vendorId) {
        const vendorNotif = renderNotification(NOTIFICATION_TYPES.DISPUTE_RESOLVED_VENDOR_NOTICE, {
          serviceName: booking.service?.name,
          bookingId,
        });
        await addNotificationJob({
          type: vendorNotif.type,
          recipientId: booking.service.vendorId,
          title: vendorNotif.title,
          body: vendorNotif.body,
          metadata: { type: vendorNotif.type, data: vendorNotif.data, bookingId },
          socketEvent: "dispute_resolved",
          socketData: { bookingId, resolution: "customer" },
        });
      }
    } catch (notifyError) {
      Logger.error(`[Admin] Failed to send dispute-resolution notifications for booking ${bookingId}: ${notifyError.message}`);
    }

    return res.json({ booking: updated });
  } catch (error) {
    Logger.error(`[Admin] resolveDisputeForCustomer failed: ${error.message}`);
    return res.status(500).json({ message: "Server Error" });
  }
};
