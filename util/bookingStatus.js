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
