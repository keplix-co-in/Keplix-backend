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

/**
 * Query parsing for GET /admin/vendors/approvals. Hand-rolled (not zod) so every
 * bad value yields a specific message. Returns { value } or { error }.
 */
export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "suspended", "all"];
export const APPROVAL_MAX_LIMIT = 50;

const one = (v) => (Array.isArray(v) ? v[0] : v);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const parseDate = (raw, endOfDay) => {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim();
  const d = new Date(DATE_ONLY.test(s) && endOfDay ? `${s}T23:59:59.999Z` : s);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

export const parseApprovalsQuery = (query = {}) => {
  const status = String(one(query.status) ?? "pending").trim().toLowerCase();
  if (!APPROVAL_STATUSES.includes(status)) {
    return { error: `status must be one of: ${APPROVAL_STATUSES.join(", ")}` };
  }
  const intIn = (raw, name, def, min, max) => {
    if (raw === undefined || raw === "") return { v: def };
    if (!/^\d+$/.test(String(raw))) return { e: `${name} must be a positive integer` };
    return { v: Math.min(max, Math.max(min, parseInt(raw, 10))) };
  };
  const pg = intIn(one(query.page), "page", 1, 1, 1000000);
  if (pg.e) return { error: pg.e };
  const lm = intIn(one(query.limit), "limit", 20, 1, APPROVAL_MAX_LIMIT);
  if (lm.e) return { error: lm.e };

  const from = parseDate(one(query.from), false);
  if (from === undefined) return { error: "from must be a valid date" };
  const to = parseDate(one(query.to), true);
  if (to === undefined) return { error: "to must be a valid date" };
  if (from && to && from > to) return { error: "from must not be after to" };

  const onboardingRaw = one(query.onboarding);
  let onboarding = null;
  if (onboardingRaw !== undefined && onboardingRaw !== "" && onboardingRaw !== "all") {
    if (!["complete", "incomplete"].includes(onboardingRaw)) {
      return { error: "onboarding must be one of: complete, incomplete, all" };
    }
    onboarding = onboardingRaw;
  }
  const clean = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  return {
    value: {
      status, page: pg.v, limit: lm.v, from, to, onboarding,
      city: clean(one(query.city), 80), q: clean(one(query.q), 100),
    },
  };
};
