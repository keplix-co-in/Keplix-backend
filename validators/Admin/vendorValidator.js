import { z } from "zod";

/**
 * Admin vendor-status change.
 *
 * The allowed values are exactly the ones the existing admin read queries look
 * for (Admin/vendorController.js getVendors, dashBoardController.js), so the
 * write vocabulary matches the read vocabulary rather than inventing a new one.
 * "pending" is included so an approval can be walked back to unreviewed.
 */
export const setVendorStatusSchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "suspended"], {
    errorMap: () => ({ message: "status must be one of: pending, approved, rejected, suspended" }),
  }),
  // Free text, but recorded in the audit log line. Required for the negative
  // actions, because "why was this workshop suspended" is the first question
  // anyone asks afterwards.
  reason: z.string().trim().min(3).max(500).optional(),
}).refine(
  (v) => v.status === "approved" || v.status === "pending" || Boolean(v.reason),
  { message: "A reason is required when rejecting or suspending a vendor", path: ["reason"] },
);
