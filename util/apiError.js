/**
 * Error body for the subscription / pay-at-garage work (2026-11-22 decision).
 * docs/SUBSCRIPTIONS_API.md names `{error:{code,message}}` but also says "same
 * envelope as PRICING_V2_API.md" (`{success:false,message,code}`); the two
 * disagree, so both shapes are sent and either client style works.
 */
export const sendError = (res, status, code, message, extra = {}) =>
  res.status(status).json({ success: false, message, code, error: { code, message }, ...extra });
