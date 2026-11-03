// Booking states that decide whether a vendor payout may be sent. Shared by
// services/payoutService.js (admin "Pay") and workers/payoutProcessor.js (the
// last check before money moves), so the two can't disagree. Kept in util/
// with no imports so the worker can use it without pulling in the queue.

// The vendor has finished the job. WHY (2026-11-03 review): settle only
// checked for cancelled/refunded/disputed, so an admin could pay out a booking
// that was merely confirmed or in progress.
export const PAYOUT_READY_BOOKING_STATUSES = ["service_completed", "user_confirmed", "completed"];

// Nothing to pay out. "canceled" is a legacy spelling still in old rows (see
// util/refundView.js).
export const PAYOUT_DEAD_BOOKING_STATUSES = ["cancelled", "canceled", "refunded", "disputed"];

// Refund states that must stop a vendor payout. WHY not RESERVED_STATUSES
// (2026-11-03): that list includes "processed", so ONE finished partial refund
// blocked the vendor's payout forever. Owner decision: after a partial refund
// the vendor gets 90% of what is left, and recomputeSplitAfterRefunds() in services/refundService.js
// rewrites vendorAmount when a refund lands, so a finished refund no longer
// needs to block. Only refunds whose outcome is still unknown do:
//   initiated / gateway_confirmed - the money may still move
//   reconciliation_needed         - our books disagree, a human must look
export const PAYOUT_BLOCKING_STATUSES = ["initiated", "gateway_confirmed", "reconciliation_needed"];
