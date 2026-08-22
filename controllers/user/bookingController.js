import prisma from "../../util/prisma.js";
import { addNotificationJob } from "../../queues/notificationQueue.js";
import { resolveServiceAmount } from "../../util/servicePricing.js";
import { executeCancellationRefund, resolveCancellationRefund } from "../../services/refundPolicy.js";
import { buildRefundView, REFUND_ETA_TEXT } from "../../util/refundView.js";
import { generateSlots, isHoliday, minutesToLabel, parseTimeToMinutes, toCanonicalTime } from "../../util/slots.js";
import { getISTDate } from "../../util/time.js";



// Exactly the vehicle fields the booking screens render. A select (rather than
// `vehicle: true`) keeps owner ids, odometer and internal flags out of a
// response that is sent to the customer app on every booking list load.
const VEHICLE_SUMMARY_SELECT = {
  id: true,
  registration: true,
  make: true,
  model: true,
  year: true,
  colour: true,
  fuel_type: true,
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Statuses that do NOT hold a slot. Everything else — pending, confirmed,
// scheduled, in_progress, completed … — occupies the vendor's time and must
// make the slot unavailable. Expressed as an exclusion list deliberately: a
// new status added later should default to "occupies the slot", because
// double-booking a vendor is far worse than hiding one slot too many.
const SLOT_FREEING_STATUSES = ["cancelled", "rejected"];

// @desc    Bookable 30-minute slots for a vendor on a given date
// @route   GET /service_api/user/vendors/:vendorId/slots?date=YYYY-MM-DD
export const getVendorSlots = async (req, res) => {
  try {
    const vendorId = parseInt(req.params.vendorId);
    if (isNaN(vendorId)) {
      return res.status(400).json({ success: false, message: "Invalid vendorId" });
    }

    const dateStr = String(req.query.date ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res
        .status(400)
        .json({ success: false, message: "date is required in YYYY-MM-DD format" });
    }

    // Parsed as UTC midnight, which is how booking_date rows are written
    // (`new Date("YYYY-MM-DD")`), so the day-window filter below lines up with
    // what is actually stored.
    const dayStart = new Date(`${dateStr}T00:00:00.000Z`);
    if (isNaN(dayStart.getTime())) {
      return res.status(400).json({ success: false, message: "Invalid date" });
    }
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const profile = await prisma.vendorProfile.findUnique({
      where: { userId: vendorId },
      select: { operating_hours: true, breaks: true, holidays: true },
    });

    if (!profile) {
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }

    const weekday = WEEKDAYS[dayStart.getUTCDay()];

    // Closed: either the weekday is a declared holiday, or the hours string is
    // absent/unparseable. Both are reported the same way — an empty slot list
    // with closed:true — because from the customer's side "this garage has no
    // usable hours on record" and "this garage is shut" are the same outcome,
    // and guessing default hours for a vendor who never entered any would
    // create bookings nobody is there to honour.
    if (isHoliday(profile.holidays, weekday)) {
      return res.json({ success: true, data: { date: dateStr, closed: true, slots: [] } });
    }

    const generated = generateSlots(profile);
    if (generated.length === 0) {
      return res.json({ success: true, data: { date: dateStr, closed: true, slots: [] } });
    }

    // Bookings reach a vendor only through service.vendorId — Booking itself
    // carries no vendorId column.
    const taken = await prisma.booking.findMany({
      where: {
        service: { vendorId },
        booking_date: { gte: dayStart, lt: dayEnd },
        NOT: { status: { in: SLOT_FREEING_STATUSES } },
      },
      select: { booking_time: true },
    });

    // Normalise BOTH sides: legacy rows hold "2:00 PM" while new rows hold
    // "14:00", and a raw string comparison would silently mark every legacy
    // booking's slot as free.
    const takenTimes = new Set(
      taken.map((b) => toCanonicalTime(b.booking_time)).filter(Boolean)
    );

    // Past slots on today's date are not bookable. Compared in IST, the
    // timezone the business actually operates in — using server-local time
    // would open or close slots by hours depending on where this runs.
    const nowIST = getISTDate();
    const todayIST = `${nowIST.getFullYear()}-${String(nowIST.getMonth() + 1).padStart(2, "0")}-${String(nowIST.getDate()).padStart(2, "0")}`;
    const isToday = todayIST === dateStr;
    const nowMinutes = nowIST.getHours() * 60 + nowIST.getMinutes();

    const slots = generated
      .filter((slot) => {
        if (!isToday) return true;
        const [h, m] = slot.time.split(":").map(Number);
        return h * 60 + m > nowMinutes;
      })
      .map((slot) => ({ ...slot, available: !takenTimes.has(slot.time) }));

    res.json({ success: true, data: { date: dateStr, closed: false, slots } });
  } catch (error) {
    console.error("getVendorSlots error:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

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
        // The customer app shows "which car is this for" on the booking card.
        // createBooking has always written this row, but no read path included
        // it, so the app had no way to render the vehicle at all.
        bookingVehicle: { include: { vehicle: { select: VEHICLE_SUMMARY_SELECT } } },
        // Without this the customer app cannot see that the vendor has asked to
        // start early, so respondToEarlyStart could never be reached and the
        // vendor-side request would dead-end.
        earlyStart: true,
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
        review: true,
        bookingVehicle: { include: { vehicle: { select: VEHICLE_SUMMARY_SELECT } } },
        // Without this the customer app cannot see that the vendor has asked to
        // start early, so respondToEarlyStart could never be reached and the
        // vendor-side request would dead-end.
        earlyStart: true,
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

        // booking_time arrives as free text ("2:00 PM" from older clients,
        // "14:00" from the current one). Everything downstream — the conflict
        // check below, the slots endpoint, the vendor's day view — compares
        // times as strings, so it is stored canonically and compared
        // canonically. Unparseable input is rejected here rather than written
        // as an uncomparable string that would silently never conflict with
        // anything.
        const canonicalTime = toCanonicalTime(booking_time);
        if (!canonicalTime) {
            return res.status(400).json({ message: "Invalid booking time" });
        }
        const bookingDate = new Date(booking_date);

        // Booking + BookingVehicle together: a booking that priced against a
        // vehicle but has no snapshot row (or vice versa) is an inconsistent
        // state neither payment code path can safely reason about.
        const booking = await prisma.$transaction(async (tx) => {
            // === DOUBLE-BOOKING GUARD ===
            // There is no unique constraint covering (vendor, date, time), and
            // until now there was no check either — two customers hitting
            // "book" on the same slot both succeeded, and the vendor found out
            // on the day.
            //
            // This MUST stay inside the transaction: a check before
            // $transaction is a classic check-then-act race, and the losing
            // request would still insert. Inside, the read and the insert are
            // one atomic unit against the same snapshot.
            //
            // Both time representations are matched because legacy rows still
            // hold "2:00 PM" — comparing only the canonical form would let a
            // new booking land on top of every pre-existing one.
            // The 12-hour label ("2:00 PM") is what legacy rows hold, so it
            // must be in the list even when the REQUEST arrived canonical
            // ("14:00") — matching only the canonical form and the raw request
            // string let a new "14:00" booking land straight on top of an
            // existing "2:00 PM" row.
            const timeVariants = [canonicalTime];
            const legacyLabel = minutesToLabel(parseTimeToMinutes(canonicalTime));
            if (legacyLabel && !timeVariants.includes(legacyLabel)) {
                timeVariants.push(legacyLabel);
            }
            if (typeof booking_time === 'string' && !timeVariants.includes(booking_time.trim())) {
                timeVariants.push(booking_time.trim());
            }

            const clash = await tx.booking.findFirst({
                where: {
                    // Bookings reach a vendor only via service.vendorId —
                    // Booking has no vendorId column of its own.
                    service: { vendorId: service.vendorId },
                    booking_date: bookingDate,
                    booking_time: { in: timeVariants },
                    NOT: { status: { in: ['cancelled', 'rejected'] } },
                },
                select: { id: true },
            });

            if (clash) {
                // Surfaced as 409 by the caller. Thrown rather than returned so
                // the transaction rolls back and nothing is written.
                const conflictError = new Error(
                    "That slot has just been booked and is no longer available. Please pick another time."
                );
                conflictError.statusCode = 409;
                throw conflictError;
            }

            const created = await tx.booking.create({
                data: {
                    userId: req.user.id,
                    serviceId: serviceId, // Already validated as number by Zod
                    booking_date: bookingDate,
                    booking_time: canonicalTime,
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
        // The double-booking guard throws from inside the transaction so the
        // whole thing rolls back; it is a client-visible conflict, not a bug.
        if (error?.statusCode === 409) {
            return res.status(409).json({ message: error.message, code: 'SLOT_TAKEN' });
        }
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

  // Same normalisation as createBooking: a reschedule must not reintroduce a
  // free-text time that the slot and conflict checks cannot see.
  let canonicalTime;
  if (booking_time) {
    canonicalTime = toCanonicalTime(booking_time);
    if (!canonicalTime) {
      return res.status(400).json({ message: "Invalid booking time" });
    }
  }

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
        booking_time: canonicalTime || undefined,
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


// @desc    Customer accepts or declines the vendor's early-start request
// @route   POST /service_api/user/:userId/bookings/:id/early-start/respond
// @body    { accept: boolean }
export const respondToEarlyStart = async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id);
    if (isNaN(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking id" });
    }

    const accept = req.body?.accept === true;

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { service: true, earlyStart: true },
    });

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }
    if (booking.userId !== req.user.id) {
      return res.status(403).json({ success: false, message: "Not authorized for this booking" });
    }
    if (!booking.earlyStart || booking.earlyStart.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: "There is no pending early-start request for this booking",
      });
    }

    if (!accept) {
      await prisma.bookingEarlyStart.update({
        where: { bookingId },
        data: { status: 'declined', responded_at: new Date() },
      });

      try {
        await addNotificationJob({
          type: 'EARLY_START_DECLINED',
          recipientId: booking.service.vendorId,
          title: "Early start declined",
          body: `The customer would prefer to keep the original time for ${booking.service.name}.`,
          metadata: { type: 'EARLY_START_DECLINED', bookingId },
          socketEvent: "early_start_declined",
          socketData: { bookingId },
        });
      } catch (notifyError) {
        console.error('Failed to queue EARLY_START_DECLINED for booking', bookingId, notifyError);
      }

      return res.json({
        success: true,
        booking,
        message: "Early start declined. Your original time stands.",
      });
    }

    const startedAt = new Date();

    // One transaction: moving the booking to in_progress and marking the
    // request accepted are the same decision. Half of it landing would leave a
    // job that is running against a request still showing as pending.
    //
    // Moving booking_time to the earlier slot is what "frees the original
    // slot": slot occupancy is derived from booking_time (see getVendorSlots),
    // so the later window becomes bookable again the moment this commits.
    const updated = await prisma.$transaction(async (tx) => {
      await tx.bookingEarlyStart.update({
        where: { bookingId },
        data: { status: 'accepted', responded_at: startedAt, started_at: startedAt },
      });

      return tx.booking.update({
        where: { id: bookingId },
        data: {
          status: 'in_progress',
          booking_time: booking.earlyStart.requested_time,
        },
        include: {
          service: true,
          earlyStart: true,
          bookingVehicle: { include: { vehicle: { select: VEHICLE_SUMMARY_SELECT } } },
        },
      });
    });

    try {
      await addNotificationJob({
        type: 'EARLY_START_ACCEPTED',
        recipientId: booking.service.vendorId,
        title: "Early start accepted",
        body: `The customer agreed to start ${booking.service.name} early. The job is now in progress.`,
        metadata: { type: 'EARLY_START_ACCEPTED', bookingId },
        socketEvent: "early_start_accepted",
        socketData: { bookingId, booking_time: updated.booking_time },
      });
    } catch (notifyError) {
      console.error('Failed to queue EARLY_START_ACCEPTED for booking', bookingId, notifyError);
    }

    res.json({
      success: true,
      booking: updated,
      message: "Early start accepted. Your service is now in progress.",
    });
  } catch (error) {
    console.error("respondToEarlyStart error:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};
