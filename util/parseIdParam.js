/**
 * util/parseIdParam.js
 *
 * Turns a route parameter (`:id`, `:bookingId`, ...) into a positive integer
 * row id, or null when it is not one.
 *
 * Why this exists: booking handlers did `parseInt(req.params.id)` and passed
 * the result straight to Prisma. A non-numeric id (an unfilled Postman
 * `{{bookingId}}`, a client bug sending "undefined") became NaN, Prisma threw
 * "Argument `id` is missing", and the catch-all turned it into a 500 -- a
 * client mistake reported as a server fault (Postman run, 2026-10-17).
 * Callers now answer 400 when this returns null.
 *
 * Stricter than parseInt on purpose: parseInt("12abc") is 12, which would
 * silently act on booking 12. Only a plain run of digits is accepted, and it
 * must fit Postgres' 4-byte `Int` (Prisma rejects anything larger with
 * another 500).
 */
const MAX_INT4 = 2147483647;

export const parseIdParam = (value) => {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 && value <= MAX_INT4 ? value : null;
  }
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const n = Number(raw);
  return n <= MAX_INT4 ? n : null;
};

export default parseIdParam;
