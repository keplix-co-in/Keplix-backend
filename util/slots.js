/**
 * util/slots.js
 *
 * Pure helpers for turning a vendor's FREE-TEXT opening hours into bookable
 * 30-minute slots, and for normalising the equally free-text
 * `Booking.booking_time` into a single canonical representation.
 *
 * Why this is defensive to the point of paranoia: `VendorProfile.operating_hours`,
 * `.breaks` and `.holidays` are plain `String?` columns typed by hand in the
 * vendor app. There is no validation behind them, so every value here is
 * attacker-or-typo shaped. Nothing in this file throws — malformed input yields
 * `null` or `[]`, because a garbled hours string must render "closed", never a
 * 500 on the customer's booking screen.
 *
 * Everything is pure and synchronous so it can be unit-tested without a
 * database (tests/util/slots.test.js).
 */

export const SLOT_MINUTES = 30;

const TIME_RE = /^(\d{1,2})\s*[:.]\s*(\d{1,2})\s*([ap]\.?m\.?)?$/i;
// "10 AM" with no minutes — common enough in hand-typed hours to be worth
// accepting, but only WITH a meridiem, so a bare "10" is not read as a time.
const HOUR_ONLY_RE = /^(\d{1,2})\s*([ap]\.?m\.?)$/i;

/**
 * Parse a single clock time to minutes-since-midnight.
 * Accepts "10:00 AM", "8:00 pm", "9:15am", "14:00", "10 AM".
 * @returns {number|null} 0..1439, or null if unparseable.
 */
export const parseTimeToMinutes = (value) => {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;

  let match = TIME_RE.exec(raw);
  let hour;
  let minute;
  let meridiem;

  if (match) {
    hour = Number(match[1]);
    minute = Number(match[2]);
    meridiem = match[3];
  } else {
    match = HOUR_ONLY_RE.exec(raw);
    if (!match) return null;
    hour = Number(match[1]);
    minute = 0;
    meridiem = match[2];
  }

  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (minute > 59) return null;

  if (meridiem) {
    const isPM = /^p/i.test(meridiem.replace(/\./g, ""));
    // 12-hour clock: hours must be 1..12, and 12 is the odd one out at both ends.
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
    if (isPM) hour += 12;
  } else if (hour > 23) {
    return null;
  }

  return hour * 60 + minute;
};

/** minutes-since-midnight -> canonical 24h "HH:mm". */
export const minutesToCanonical = (minutes) => {
  if (!Number.isFinite(minutes)) return null;
  const m = Math.trunc(minutes);
  if (m < 0 || m > 24 * 60) return null;
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** minutes-since-midnight -> display label, e.g. 750 -> "12:30 PM". */
export const minutesToLabel = (minutes) => {
  if (!Number.isFinite(minutes)) return null;
  const m = Math.trunc(minutes);
  if (m < 0 || m >= 24 * 60) return null;
  const hour24 = Math.floor(m / 60);
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(m % 60).padStart(2, "0")} ${suffix}`;
};

/**
 * The single normaliser every comparison must go through.
 *
 * `Booking.booking_time` is a free String and older clients still send
 * "2:00 PM". Storing and comparing canonical "HH:mm" is what makes the
 * conflict check and the slot availability check able to see each other's
 * rows at all.
 *
 * @returns {string|null} "HH:mm", or null if the input is not a time.
 */
export const toCanonicalTime = (value) => {
  const minutes = parseTimeToMinutes(value);
  return minutes === null ? null : minutesToCanonical(minutes);
};

/**
 * Parse "10:00 AM - 8:00 PM" (also en/em dash, "to") into minute bounds.
 * @returns {{start:number,end:number}|null} null when malformed or inverted.
 */
export const parseTimeRange = (value) => {
  if (typeof value !== "string") return null;
  const parts = value.split(/\s*(?:-|–|—|to)\s*/i).filter((p) => p.trim());
  if (parts.length !== 2) return null;

  const start = parseTimeToMinutes(parts[0]);
  const end = parseTimeToMinutes(parts[1]);
  if (start === null || end === null) return null;
  // An inverted or empty range (an overnight shift, or a typo) has no
  // meaningful 30-minute expansion — treat it as unparseable rather than
  // inventing slots.
  if (end <= start) return null;

  return { start, end };
};

/**
 * Coerce the `breaks` / `holidays` columns — which may be a JSON string, an
 * already-parsed array, or junk — into an array. Never throws.
 */
export const parseJsonArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  const raw = value.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Tolerate a bare comma-separated string ("1 PM - 2 PM, 5 PM - 6 PM"),
    // which is what a vendor typing into a plain text box actually produces.
    return raw.includes(",") ? raw.split(",") : [raw];
  }
};

/**
 * Is `weekday` (e.g. "Sunday") listed in the vendor's holidays?
 * Case- and whitespace-insensitive.
 */
export const isHoliday = (holidays, weekday) => {
  if (typeof weekday !== "string") return false;
  const target = weekday.trim().toLowerCase();
  return parseJsonArray(holidays).some(
    (h) => typeof h === "string" && h.trim().toLowerCase() === target
  );
};

/**
 * Generate the vendor's bookable slots for a day.
 *
 * A slot is dropped if it OVERLAPS a break at all (its 30 minutes are not
 * free), not merely if its start instant is inside one — a 1:30 slot against a
 * 2:00 break start would otherwise be offered and then run straight into it.
 *
 * @param {{operating_hours?: string, breaks?: string|string[]}} [profile]
 * @returns {Array<{time: string, label: string}>} empty on any malformed input.
 */
export const generateSlots = (profile = {}) => {
  const { operating_hours, breaks } = profile ?? {};

  const hours = parseTimeRange(operating_hours);
  if (!hours) return [];

  const breakRanges = parseJsonArray(breaks)
    .map((b) => parseTimeRange(b))
    .filter(Boolean);

  const slots = [];
  for (let start = hours.start; start + SLOT_MINUTES <= hours.end; start += SLOT_MINUTES) {
    const end = start + SLOT_MINUTES;
    const clashes = breakRanges.some((br) => start < br.end && end > br.start);
    if (clashes) continue;

    const time = minutesToCanonical(start);
    const label = minutesToLabel(start);
    if (time && label) slots.push({ time, label });
  }

  return slots;
};

export default { generateSlots, toCanonicalTime, parseTimeToMinutes, parseTimeRange };
