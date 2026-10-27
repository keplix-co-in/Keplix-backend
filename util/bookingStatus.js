// Single source of truth for the strings allowed into Booking.status and
// Booking.vendor_status. Three write sites (controllers/vendor/bookingController.js
// respondToServiceRequest and updateBookingStatus, controllers/user/bookingController.js
// updateBooking) previously wrote whatever the request body contained
// verbatim -- an arbitrary string in the status column, silently accepted.

export const VALID_BOOKING_STATUSES = [
  "pending",
  "confirmed",
  "scheduled",
  "in_progress",
  "service_completed",
  "completed",
  "user_confirmed",
  "cancelled",
  "disputed",
];

export const VALID_VENDOR_STATUSES = ["pending", "accepted", "rejected"];

export const isValidBookingStatus = (value) => VALID_BOOKING_STATUSES.includes(value);
export const isValidVendorStatus = (value) => VALID_VENDOR_STATUSES.includes(value);

// States a CUSTOMER may cancel or reschedule from. Owner-approved booking-flow
// plan (2026-10-20): once the vendor has started (in_progress) the job is
// physically under way, and from service_completed onwards the customer's
// remedy is confirm-or-dispute, not cancellation -- cancelling in_progress used
// to be allowed and produced a "cancelled" booking with work half done and a
// refund decision nobody could reason about. Enforced with a guarded
// updateMany so a vendor/cron write that lands between the read and the write
// cannot be silently overwritten.
export const USER_CANCELLABLE_STATUSES = ["pending", "confirmed", "scheduled"];
export const USER_RESCHEDULABLE_STATUSES = ["pending", "confirmed", "scheduled"];

// States in which a vendor-accepted booking may still be PAID for. Wider than
// "pending/confirmed/scheduled" on purpose: the activation cron
// (util/bookingStatusManager.js) moves an accepted booking to in_progress at
// its slot time whether or not it has been paid, and nothing stops the vendor
// then marking it service_completed. Refusing payment in those states would
// leave a started or finished job permanently unpayable.
// What must never be payable is a dead booking (cancelled/rejected) or one
// already settled (user_confirmed/completed) or in dispute.
export const PAYABLE_BOOKING_STATUSES = [
  "pending",
  "confirmed",
  "scheduled",
  "in_progress",
  "service_completed",
];

export const isBookingPayable = (booking) =>
  Boolean(booking) &&
  booking.vendor_status === "accepted" &&
  PAYABLE_BOOKING_STATUSES.includes(booking.status);
