import prisma from "../../util/prisma.js";
import { addNotificationJob } from "../../queues/notificationQueue.js";
import { resolveServiceAmount } from "../../util/servicePricing.js";
import { executeCancellationRefund, resolveCancellationRefund } from "../../services/refundPolicy.js";
import { buildRefundView, REFUND_ETA_TEXT } from "../../util/refundView.js";



// @desc    Get payment by bookingId
// @route   GET /service_api/bookings/:bookingId/payment
export const getPaymentByBooking = async (req, res) => {
  try {
    const bookingId = parseInt(req.params.bookingId);
    if (isNaN(bookingId)) {
      return res.status(400).json({ message: "Invalid bookingId" });
    }
    // Only allow if user owns the booking
    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, userId: req.user.id },
      include: { payment: true }
    });
    if (!booking) {
      return res.status(404).json({ message: "Booking not found or not authorized" });
    }
    if (!booking.payment) {
      return res.status(404).json({ message: "No payment found for this booking" });
    }
    res.json(booking.payment);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Get bookings for logged in user
// @route   GET /service_api/user/bookings/
export const getUserBookings = async (req, res) => {
  try {
    // query params
    const { page = 1, limit = 200, search } = req.query;
    const skip = (page - 1) * limit;

    let where = { userId: req.user.id };
    if (search) {
      where.OR = [
        {
          service: {
            name: { contains: search, mode: "insensitive" },
          },
        },
        {
          notes: { contains: search, mode: "insensitive" },
        },
        {
          status: { contains: search, mode: "insensitive" },
        },
      ];
    }

    const bookings = await prisma.booking.findMany({
      where,
      skip: Number(skip),
      take: Number(limit),
      include: {
        service: {
          include: { vendor: { include: { vendorProfile: true } } },
        },
        // Refunds ride along with the payment so the app can answer "where is
        // my money" without a second round trip — which is what most refund
        // support contacts actually are.
        payment: { include: { refunds: true } },
      },
      orderBy: { booking_date: "desc" },
    });

    const total = await prisma.booking.count({ where });

    const formattedBookings = bookings.map((booking) => ({
      ...booking,
      service: {
        ...booking.service,
        image_url: booking.service.image_url
          ? `${req.protocol}://${req.get("host")}${booking.service.image_url}`
          : null,
        image: booking.service.image_url
          ? `${req.protocol}://${req.get("host")}${booking.service.image_url}`
          : null,
        vendor_name:
          booking.service.vendor?.vendorProfile?.business_name || "Vendor",
        vendor_image: booking.service.vendor?.vendorProfile?.image
          ? `${req.protocol}://${req.get("host")}${booking.service.vendor.vendorProfile.image}`
          : null,
        cover_image: booking.service.vendor?.vendorProfile?.cover_image
          ? `${req.protocol}://${req.get("host")}${booking.service.vendor.vendorProfile.cover_image}`
          : null,
      },
      refund: buildRefundView({ booking, payment: booking.payment }),
    }));

    res.json(formattedBookings);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Get single booking
// @route   GET /service_api/user/:userId/bookings/:id
export const getSingleBooking = async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id);
    const userId = parseInt(req.params.userId);

    const booking = await prisma.booking.findFirst({
      where: { 
        id: bookingId,
        userId: userId // Ensure user owns this booking
      },
      include: {
        service: {
          include: { vendor: { include: { vendorProfile: true } } },
        },
        payment: { include: { refunds: true } },
        review: true
      },
    });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    res.json({ ...booking, refund: buildRefundView({ booking, payment: booking.payment }) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    What a customer would get back if they cancelled this booking now
// @route   GET /service_api/user/:userId/bookings/:id/cancellation-preview
//
// Read-only. Exists so the cancel screen can state the exact figure BEFORE the
// customer commits, rather than letting them discover afterwards that the
// refund was short by the gateway fee. Same resolver the real cancellation
// uses, so the preview and the outcome cannot disagree.
export const getCancellationPreview = async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id);

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { payment: true },
    });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (booking.userId !== req.user.id) {
      return res.status(403).json({ message: "Not authorized for this booking" });
    }

    const decision = await resolveCancellationRefund({
      booking,
      payment: booking.payment,
    });

    res.json({
      // false here covers both "nothing was paid" and "too late to
      // auto-refund" — the app decides which message to show from `code`.
      refundable: decision.eligible,
      amount: decision.amount ?? null,
      feeDeducted: decision.feeDeducted ?? 0,
      code: decision.code,
      message: decision.reason,
      etaText: REFUND_ETA_TEXT,
      // Distinguishes "no money involved at all" (show nothing) from "paid but
      // needs review" (show the review wording, never an amount).
      wasPaid: booking.payment?.status === 'success',
    });
  } catch (error) {
    console.error("Cancellation preview error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Create a new booking request (vendor must accept before payment)
// @route   POST /service_api/bookings/
export const createBooking = async (req, res) => {

    const { serviceId, booking_date, booking_time, notes, vehicleId } = req.body;

    try {
        // Resolve the vehicle (if one was sent) and its segment price BEFORE
        // creating anything, so a bad vehicleId fails the request cleanly
        // instead of leaving a half-formed booking.
        let vehicle = null;
        if (vehicleId) {
            vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
            // Ownership check: a vehicleId is only trustworthy if it actually
            // belongs to the caller. Without this, any authenticated user could
            // attach ANY vehicle row (and therefore its segment/history) to
            // their own booking.
            if (!vehicle || vehicle.ownerUserId !== req.user.id) {
                return res.status(403).json({ message: "Vehicle not found or not yours" });
            }
        }

        const service = await prisma.service.findUnique({
            where: { id: serviceId },
            include: { segmentPrices: true },
        });
        if (!service) {
            return res.status(404).json({ message: "Service not found" });
        }

        // Snapshot the price NOW, at the segment this vehicle resolves to. This
        // is what BookingVehicle.price_snapshot exists for: the vendor editing
        // segment prices tomorrow must not change what this booking charges.
        const priceSnapshot = resolveServiceAmount(service, vehicle?.segment ?? null);

        // Booking + BookingVehicle together: a booking that priced against a
        // vehicle but has no snapshot row (or vice versa) is an inconsistent
        // state neither payment code path can safely reason about.
        const booking = await prisma.$transaction(async (tx) => {
            const created = await tx.booking.create({
                data: {
                    userId: req.user.id,
                    serviceId: serviceId, // Already validated as number by Zod
                    booking_date: new Date(booking_date),
                    booking_time,
                    notes,
                    vendor_status: 'pending', // Vendor must accept/reject
                    status: 'pending', // Overall status
                    conversation: {
                        create: {} // Automatically create a conversation for this booking
                    }
                },
                include: {
                    service: true,
                    user: {
                        include: {
                            userProfile: true
                        }
                    }
                }
            });

            await tx.bookingVehicle.create({
                data: {
                    bookingId: created.id,
                    vehicleId: vehicle?.id ?? null,
                    segment: vehicle?.segment ?? null,
                    price_snapshot: priceSnapshot,
                },
            });

            return created;
        });

        // Notify Vendor about new request via Queue. The booking itself is
        // already committed above — a Redis/queue outage (e.g. the Upstash
        // request-quota errors seen in production) must not turn an already-
        // successful booking into a 500 for the user. Best-effort only.
        if (booking.service && booking.service.vendorId) {
            try {
                await addNotificationJob({
                    type: 'NEW_BOOKING_ALERT',
                    recipientId: booking.service.vendorId,
                    title: "New Service Request",
                    body: `${booking.user.userProfile?.name || 'A user'} requested ${booking.service.name} on ${new Date(booking_date).toLocaleDateString()}`,
                    metadata: { type: 'NEW_BOOKING_ALERT', bookingId: booking.id },
                    socketEvent: "new_service_request",
                    socketData: {
                        bookingId: booking.id,
                        service: booking.service.name,
                        userName: booking.user.userProfile?.name || 'User',
                        date: booking_date,
                        time: booking_time,
                        message: "You have a new service request! Please accept or reject."
                    }
                });
            } catch (notifyError) {
                console.error('Failed to queue NEW_BOOKING_ALERT for booking', booking.id, notifyError);
            }
        }

        res.status(201).json({
            ...booking,
            message: "Service request sent to vendor. Waiting for acceptance."
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

// @desc    Check if booking request was accepted by vendor (for payment)
// @route   GET /service_api/user/:userId/bookings/:id/can-pay
export const canProceedToPayment = async (req, res) => {
  const bookingId = parseInt(req.params.id);
  
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        service: true,
        payment: true
      }
    });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    // Ensure user owns the booking
    if (booking.userId !== req.user.id) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Check vendor acceptance status
    const canPay = booking.vendor_status === 'accepted' && !booking.payment;

    res.json({
      canPay,
      vendor_status: booking.vendor_status,
      status: booking.status,
      hasPayment: !!booking.payment,
      booking
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Update/Cancel booking
// @route   PUT /service_api/user/:userId/bookings/update/:id
export const updateBooking = async (req, res) => {
  const { status, booking_date, booking_time, notes } = req.body;
  const bookingId = parseInt(req.params.id);

  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      // Payment is needed to decide a cancellation refund below. Loaded here
      // rather than re-queried later so the refund decision sees the booking
      // exactly as it was BEFORE the cancellation was written.
      include: { payment: true },
    });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    // Ensure user owns the booking
    if (booking.userId !== req.user.id) {
      return res
        .status(403)
        .json({ message: "Not authorized to update this booking" });
    }

    // Only allow cancellation if status is pending or confirmed (not completed)
    if (status === "cancelled") {
      if (booking.status === "completed" || booking.status === "cancelled") {
        return res
          .status(400)
          .json({
            message: `Cannot cancel booking that is already ${booking.status}`,
          });
      }
    }

    const updatedBooking = await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: status || undefined,
        booking_date: booking_date ? new Date(booking_date) : undefined,
        booking_time: booking_time || undefined,
        notes: notes || undefined,
      },
      include: { service: true }
    });

    // === CANCELLATION REFUND ===
    // Uses `booking` (pre-update) deliberately: resolveCancellationRefund
    // decides from the status the booking had BEFORE it became 'cancelled'.
    // Reading updatedBooking here would make every cancellation look like it
    // came from 'cancelled' and nothing would ever qualify.
    //
    // Best-effort for the same reason as the notifications below: the
    // cancellation is already committed, and a gateway failure must not turn a
    // successful cancellation into a 500. executeCancellationRefund does not
    // throw, but the extra guard costs nothing and keeps the invariant local.
    let refundOutcome = null;
    if (status === "cancelled") {
      try {
        refundOutcome = await executeCancellationRefund({
          booking,
          payment: booking.payment,
        });

        // Tell the customer what is happening to their money.
        //
        // Three cases, and the distinction matters: a refund actually issued
        // (quote the amount and the ETA), a paid cancellation that was too
        // late to auto-refund (say it's under review, quote NO amount — we
        // have not committed to paying anything), and an unpaid cancellation
        // (say nothing about money at all).
        //
        // The deep link uses screen/params rather than bookingId: the
        // bookingId branch in services/pushNotifications.js navigates to
        // BookingDetails with only an id, and that screen renders null without
        // the full booking object.
        const refundNotification = refundOutcome?.refunded
          ? {
              title: "Refund on its way",
              body:
                `₹${refundOutcome.amount.toLocaleString('en-IN')} for your cancelled booking is on ` +
                `its way back to your original payment method — it should appear ${REFUND_ETA_TEXT}.`,
            }
          : booking.payment?.status === 'success'
            ? {
                title: "Booking Cancelled",
                body:
                  "Your booking is cancelled. Our team is reviewing your refund and will " +
                  "contact you shortly.",
              }
            : null;

        if (refundNotification) {
          try {
            await addNotificationJob({
              type: 'REFUND_ISSUED',
              recipientId: booking.userId,
              title: refundNotification.title,
              body: refundNotification.body,
              metadata: {
                type: 'REFUND_ISSUED',
                bookingId: booking.id,
                screen: 'BookingList',
                params: { initialTab: 'cancelled' },
              },
              socketEvent: "refund_issued",
              socketData: { bookingId: booking.id, amount: refundOutcome?.amount ?? null },
            });
          } catch (notifyError) {
            console.error('Failed to queue REFUND_ISSUED for booking', booking.id, notifyError);
          }
        }

        // The vendor was already paid for this booking, so the refunded amount
        // is now owed back by them and there is no automatic mechanism for
        // that. Phase 2's payout hold makes this rare; when it does happen it
        // must be loud rather than silent.
        if (refundOutcome?.payoutAlreadySettled) {
          console.error(
            `[MANUAL ACTION] Booking ${booking.id} refunded after vendor payout was settled — ` +
            `₹${refundOutcome.amount} must be recovered from the vendor.`
          );
        }
      } catch (refundError) {
        console.error('Cancellation refund hook failed for booking', booking.id, refundError);
      }
    }

    // The booking row is already updated above at this point — a Redis/queue
    // outage must not turn an already-successful update into a 500 for the
    // user, so each notification is best-effort and independently caught.
    if (status === "cancelled") {
        // Queue cancellation notification for vendor
        try {
            await addNotificationJob({
                type: 'BOOKING_CANCELLED',
                recipientId: updatedBooking.service.vendorId,
                title: "Booking Cancelled",
                body: `Booking for ${updatedBooking.service.name} was cancelled by the user.`,
                socketEvent: "booking_cancelled",
                socketData: {
                    bookingId: updatedBooking.id,
                    service: updatedBooking.service.name,
                    message: "This booking was cancelled by the user."
                }
            });
        } catch (notifyError) {
            console.error('Failed to queue BOOKING_CANCELLED for booking', updatedBooking.id, notifyError);
        }
    }

    // Queue update notification for user and vendor via Queue
    // Notify the user who made the change
    try {
        await addNotificationJob({
            type: 'BOOKING_UPDATED',
            recipientId: req.user.id,
            socketEvent: "booking_updated",
            socketData: {
                bookingId: updatedBooking.id,
                action: status === "cancelled" ? "cancelled" : "updated",
                message: status === "cancelled" ? "Your booking was cancelled" : "Your booking was updated"
            }
        });
    } catch (notifyError) {
        console.error('Failed to queue BOOKING_UPDATED for booking', updatedBooking.id, notifyError);
    }

    // Notify the vendor if it's not a cancellation (vendors get specific cancellation events)
    if (status !== "cancelled") {
        try {
            await addNotificationJob({
                type: 'BOOKING_RESCHEDULED',
                recipientId: updatedBooking.service.vendorId,
                socketEvent: "booking_updated",
                socketData: {
                    bookingId: updatedBooking.id,
                    action: "rescheduled",
                    message: `Booking for ${updatedBooking.service.name} was rescheduled by the user`
                }
            });
        } catch (notifyError) {
            console.error('Failed to queue BOOKING_RESCHEDULED for booking', updatedBooking.id, notifyError);
        }
    }

    // Surface the refund in the SAME shape the bookings list uses, so the
    // cancel screen and the booking list can't disagree about what the
    // customer is owed. Re-read the payment (with refunds) rather than
    // reconstructing it from refundOutcome — the refund row is the source of
    // truth, and this way a refund that failed shows as failed here too.
    let refundView = null;
    if (status === "cancelled") {
      try {
        const paymentWithRefunds = await prisma.payment.findFirst({
          where: { bookingId },
          include: { refunds: true },
        });
        refundView = buildRefundView({
          booking: updatedBooking,
          payment: paymentWithRefunds,
        });
      } catch (viewError) {
        console.error('Failed to build refund view for booking', bookingId, viewError);
      }
    }

    res.json(refundView ? { ...updatedBooking, refund: refundView } : updatedBooking);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};


