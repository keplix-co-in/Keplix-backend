import prisma from "../../util/prisma.js";
import { initiateVendorPayout } from "../../util/payoutHelper.js";
import { sendPushNotification } from "../../util/communication.js";
import { createNotification } from "../../util/notificationHelper.js";
import { assertHealthSheetPresent } from "../../services/healthSheetService.js";
import { resolvePayoutHoldUntil } from "../../util/platformSettings.js";
import { addNotificationJob } from "../../queues/notificationQueue.js";
import { toCanonicalTime, minutesToLabel } from "../../util/slots.js";
import { getISTDate } from "../../util/time.js";



// @desc    Get bookings for logged in vendor
// @route   GET /service_api/vendor/bookings/
export const getVendorBookings = async (req, res) => {
  try {
    const { status, date, date_from, date_to, serviceName, token, page = 1, limit = 50 } = req.query;
    const skip = (page - 1) * limit;

    // Find all services by this vendor first
    const vendorServices = await prisma.service.findMany({
      where: { vendorId: req.user.id },
      select: { id: true },
    });
    const serviceIds = vendorServices.map((s) => s.id);

    let query = {
      serviceId: { in: serviceIds },
    };

    // Apply filters
    if (status) query.status = { in: status.split(",") };
    if (date) query.booking_date = new Date(date);
    if (date_from || date_to) {
      query.booking_date = {};
      if (date_from) query.booking_date.gte = new Date(date_from);
      if (date_to) query.booking_date.lte = new Date(date_to);
    }
    if (serviceName) query.service = { name: { contains: serviceName } };
    if (token) query.id = parseInt(token);

    // The "today onwards" default only makes sense for bookings that are
    // still ABOUT a future date — pending/confirmed/scheduled. Once a
    // booking is in_progress, service_completed, completed, cancelled,
    // disputed, or refunded, its original booking_date is no longer the
    // point; the vendor needs to see and act on it regardless of how old
    // that date is. This previously exempted only completed/cancelled, so a
    // booking stuck in in_progress from months ago (its scheduled date long
    // past) silently vanished from the vendor's default list — an ACTIVE job
    // the vendor could no longer find or close out.
    const now = new Date();
    const hasDateFilter = date || date_from || date_to;
    const FORWARD_LOOKING_STATUSES = ['pending', 'confirmed', 'scheduled'];
    const requestedStatuses = status ? status.split(',') : null;
    const isForwardLookingOnly =
      !requestedStatuses || requestedStatuses.every((s) => FORWARD_LOOKING_STATUSES.includes(s));

    if (!hasDateFilter && isForwardLookingOnly) {
      query.booking_date = {
        gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()) // Today and future
      };
    }

    const bookings = await prisma.booking.findMany({
      where: query,
      include: {
        user: { include: { userProfile: true } },
        service: true,
        conversation: true, // Include conversation to get conversationId for chat
        payment: true, // Include payment status
      },
      orderBy: { booking_date: "desc" },
      skip: Number(skip),
      take: Number(limit),
    });

    res.json(bookings);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Accept or reject a service request
// @route   PATCH /service_api/vendor/bookings/:id/respond
export const respondToServiceRequest = async (req, res) => {
  const { vendor_status } = req.body; // 'accepted' or 'rejected'
  const bookingId = parseInt(req.params.id);
  try {
    // Verify booking exists and belongs to vendor's services
    const booking = await prisma.booking.findFirst({
      where: { 
        id: bookingId,
        service: {
          vendorId: req.user.id
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

    if (!booking) {
      return res.status(404).json({ message: "Booking not found or unauthorized" });
    }

    if (booking.vendor_status !== 'pending') {
      return res.status(400).json({ 
        message: `Request already ${booking.vendor_status}` 
      });
    }

    // Update vendor_status
    const updatedBooking = await prisma.booking.update({
      where: { id: bookingId },
      data: { 
        vendor_status,
        status: vendor_status === 'accepted' ? 'confirmed' : 'cancelled'
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

    // Get socket instance
    const io = req.app.get("io");

    // Notify user about vendor's response
    if (vendor_status === 'accepted') {
      // Send notification (DB + Push)
      await createNotification(
        booking.userId,
        "Request Accepted!",
        `${booking.service.name} request accepted. You can now proceed with payment.`
      );

      // Socket notification
      if (io) {
        io.to(`user_${booking.userId}`).emit("request_accepted", {
          bookingId: booking.id,
          service: booking.service.name,
          message: "Your service request was accepted! Proceed to payment."
        });
      }
    } else {
      // Request rejected
      await createNotification(
        booking.userId,
        "Request Declined",
        `Sorry, ${booking.service.name} request was declined by the vendor.`
      );

      if (io) {
        io.to(`user_${booking.userId}`).emit("request_rejected", {
          bookingId: booking.id,
          service: booking.service.name,
          message: "Your service request was declined."
        });
      } else {
        // Socket not available, notification already sent via push
      }
    }

    res.json({
      ...updatedBooking,
      message: vendor_status === 'accepted' 
        ? "Service request accepted. User will be notified to proceed with payment."
        : "Service request declined."
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Update booking status
// @route   PATCH /service_api/bookings/:id/
export const updateBookingStatus = async (req, res) => {
  const { status, notes } = req.body;

  try {

    // Scoped to the caller's own services. This previously used findUnique on
    // the id alone, which meant any authenticated vendor could drive any
    // booking — including to service_completed, the step that puts a booking
    // on the escrow-release path. respondToServiceRequest above already
    // filters this way; this function was simply missing it.
    const currentBooking = await prisma.booking.findFirst({
      where: {
        id: parseInt(req.params.id),
        service: {
          vendorId: req.user.id
        }
      },
      select: { id: true, status: true, createdAt: true }
    });

    // Deliberately 404, not 403: a vendor should not be able to probe which
    // booking ids exist on other vendors.
    if (!currentBooking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (status) {
        // 1. Start Service: confirmed -> in_progress
        if (status === 'in_progress' && currentBooking.status !== 'confirmed' && currentBooking.status !== 'scheduled') {
            return res.status(400).json({
                message: `Cannot start service. Booking must be confirmed first. Current status: ${currentBooking.status}`
            });
        }

        // 2. Complete Service: in_progress -> service_completed
        if (status === 'service_completed' && currentBooking.status !== 'in_progress') {
             // Allow skipping in_progress check if it was just confirmed (for quick jobs), but typically we want the flow.
             // For now, let's allow confirmed -> service_completed too for flexibility, or enforce flow?
             // User prompt: "in_progress -> service_completed" logic implies flow.
             if (currentBooking.status !== 'confirmed' && currentBooking.status !== 'scheduled') {
                return res.status(400).json({
                    message: `Cannot mark completed. Service must be in progress or confirmed. Current status: ${currentBooking.status}`
                });
             }
        }

        // Mandatory-inspection gate. Same rule, same rollout anchoring as
        // walk-in job completion — see services/healthSheetService.js and
        // the PlatformSettings comment in schema.prisma. 409, not 400, so the
        // app can branch on this specific code and deep-link into the
        // inspection form rather than showing a generic validation error.
        // Anchored to currentBooking.createdAt, not "now": flipping the
        // rollout flag must never strand a booking that was already in
        // flight before any garage had a way to see this form — completion
        // is what releases escrow.
        //
        // Gated on 'completed' too, not just 'service_completed': despite
        // this function's own comments describing service_completed as the
        // completion step, the partner app's actual ServiceCompletion.jsx
        // screen submits status: 'completed' directly. A gate that only
        // checked 'service_completed' would never fire on a real completion
        // — caught by testing the request the app actually sends, not the
        // string this code talks about sending.
        if (status === 'service_completed' || status === 'completed') {
          const gate = await assertHealthSheetPresent({
            createdAt: currentBooking.createdAt,
            bookingId: currentBooking.id,
          });
          if (!gate.ok) {
            return res.status(409).json({ code: gate.code, message: gate.message });
          }
        }
    }

    // Prepare update data
    const updateData = { status };
    if (notes) {
      updateData.notes = notes;
    }

    // uploadFieldss sets req.files to an OBJECT keyed by field name, not an
    // array. The previous code did `(req.files || []).length > 0`, which is
    // `undefined > 0` — always false — so completion images were silently
    // never saved. It also read file.path, which is empty under
    // multer.memoryStorage(); the Cloudinary URL is on file.cloudinary.
    const uploadedFiles = Object.values(req.files ?? {}).flat();
    const imageUrls = uploadedFiles
      .map((file) => file?.cloudinary?.secure_url)
      .filter(Boolean);

    if (imageUrls.length > 0) {
        // The column is `String?`, so an array would be a type error. Nothing
        // reads this back yet (it has never contained data), so comma-separated
        // is a free choice — but whatever consumes it must split on ','.
        updateData.completion_images = imageUrls.join(',');
    }

    const booking = await prisma.booking.update({
      where: { id: parseInt(req.params.id) },
      data: updateData,
      // Include service relation so we can find vendor for payout
      include: {
        service: true
      }
    });

    // === ESCROW HOLD ===
    // Completion is what puts this booking on the payout path, so it is also
    // where the hold window starts. Stored on Payment (not Booking, which must
    // not be modified) and computed once here rather than derived at payout
    // time, so later changes to payoutHoldHours can't retroactively release
    // money that was meant to be held.
    //
    // Best-effort: the booking is already committed above, and failing to set
    // a hold must not fail the vendor's completion. The payout guard treats a
    // missing hold as releasable, so the downside is a payout that isn't
    // delayed — never a booking that can't be completed.
    if (status === 'service_completed' || status === 'completed') {
      try {
        const holdUntil = await resolvePayoutHoldUntil(new Date());
        if (holdUntil) {
          await prisma.payment.updateMany({
            where: { bookingId: booking.id },
            data: { payoutHoldUntil: holdUntil },
          });
        }
      } catch (holdError) {
        console.error('Failed to set payout hold for booking', booking.id, holdError);
      }
    }

    // === NOTIFICATIONS ===
    let title = "Booking Update";
    let body = `Your booking for ${booking.service.name} is now ${status}`;
    
    if (status === 'confirmed') {
        title = "Booking Accepted!";
        body = `The vendor has accepted your booking for ${booking.service.name}.`;
    } else if (status === 'service_completed') {
        title = "Service Completed";
        body = `The vendor has marked ${booking.service.name} as completed. Please confirm to release payment.`;
    } else if (status === 'cancelled') {
         title = "Booking Cancelled";
         body = `Your booking for ${booking.service.name} was cancelled.`;
    }

    // Store in DB & Send Push via Expo
    await createNotification(booking.userId, title, body);

    // Socket notification
    const io = req.app.get("io");   
    if (io) {
      try {
        io.to(`user_${booking.userId}`).emit("booking_updated", {
          bookingId: booking.id,
          status: booking.status,
          message: body,
        });
      } catch (socketError) {
        console.error("Socket emit error:", socketError);
      }
    }

    res.json(booking);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};


// Statuses a booking must be in for an early start to make any sense: the
// vendor has accepted it and it has not started, finished or been cancelled.
const EARLY_START_ELIGIBLE_STATUSES = ['confirmed', 'scheduled'];

// Local helper: booking_time is free text, so both the canonical "14:00" rows
// and legacy "2:00 PM" rows have to resolve to comparable minutes.
const timeToMinutes = (value) => {
  const canonical = toCanonicalTime(value);
  if (!canonical) return null;
  const [h, m] = canonical.split(":").map(Number);
  return h * 60 + m;
};

// @desc    Vendor asks the customer if the job can start earlier
// @route   POST /service_api/vendor/:vendorId/bookings/:id/early-start
//
// Deliberately does NOT change the booking's status. The customer's time is
// theirs; the vendor is only making a request, and only the customer's answer
// (respondToEarlyStart, controllers/user/bookingController.js) moves the
// booking to in_progress.
export const requestEarlyStart = async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id);
    if (isNaN(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking id" });
    }

    // Scoped to the caller's own services — same rule as updateBookingStatus.
    // 404 rather than 403 so one vendor cannot probe another's booking ids.
    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, service: { vendorId: req.user.id } },
      include: { service: true, earlyStart: true },
    });

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    if (
      booking.vendor_status !== 'accepted' ||
      !EARLY_START_ELIGIBLE_STATUSES.includes(booking.status)
    ) {
      return res.status(400).json({
        success: false,
        message: `Cannot request an early start for a booking that is ${booking.status}.`,
      });
    }

    const bookedMinutes = timeToMinutes(booking.booking_time);

    // The vendor may name a slot; if they don't, "now" — rounded down to the
    // current half-hour, the same grid util/slots.js generates — is what they
    // mean.
    let requestedTime = req.body?.booking_time ? toCanonicalTime(req.body.booking_time) : null;
    if (req.body?.booking_time && !requestedTime) {
      return res.status(400).json({ success: false, message: "Invalid time" });
    }
    if (!requestedTime) {
      const nowIST = getISTDate();
      const rounded = Math.floor((nowIST.getHours() * 60 + nowIST.getMinutes()) / 30) * 30;
      requestedTime =
        `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
    }

    const requestedMinutes = timeToMinutes(requestedTime);
    if (requestedMinutes === null || bookedMinutes === null || requestedMinutes >= bookedMinutes) {
      return res.status(400).json({
        success: false,
        message: "An early start must be earlier than the booked time.",
      });
    }

    // The earlier window has to actually be free — otherwise accepting would
    // hand the vendor two jobs at once, which is the exact problem the booking
    // conflict check exists to prevent. Both time representations are matched
    // because legacy rows still hold "2:00 PM".
    const clash = await prisma.booking.findFirst({
      where: {
        id: { not: bookingId },
        service: { vendorId: req.user.id },
        booking_date: booking.booking_date,
        booking_time: { in: [requestedTime, minutesToLabel(requestedMinutes)].filter(Boolean) },
        NOT: { status: { in: ['cancelled', 'rejected'] } },
      },
      select: { id: true },
    });

    if (clash) {
      return res.status(409).json({
        success: false,
        message: "You already have another booking in that earlier slot.",
      });
    }

    // Upsert, not create: one live offer per booking, so a re-request replaces
    // the old one instead of leaving a stale offer the customer could accept.
    await prisma.bookingEarlyStart.upsert({
      where: { bookingId },
      create: {
        bookingId,
        requested_time: requestedTime,
        requestedById: req.user.id,
        note: req.body?.note ?? null,
        status: 'pending',
      },
      update: {
        requested_time: requestedTime,
        requestedById: req.user.id,
        note: req.body?.note ?? null,
        status: 'pending',
        requested_at: new Date(),
        responded_at: null,
        started_at: null,
      },
    });

    // Best-effort, like every other notification in this file: the request row
    // is already committed and a queue outage must not turn a successful
    // request into a 500.
    try {
      await addNotificationJob({
        type: 'EARLY_START_REQUEST',
        recipientId: booking.userId,
        title: "Can we start earlier?",
        body: `Your ${booking.service.name} booking could start at ${minutesToLabel(requestedMinutes)}. Tap to accept or decline.`,
        metadata: { type: 'EARLY_START_REQUEST', bookingId, requested_time: requestedTime },
        socketEvent: "early_start_requested",
        socketData: { bookingId, requested_time: requestedTime },
      });
    } catch (notifyError) {
      console.error('Failed to queue EARLY_START_REQUEST for booking', bookingId, notifyError);
    }

    res.json({
      success: true,
      message: "Early start requested. The customer has been notified.",
    });
  } catch (error) {
    console.error("requestEarlyStart error:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};
