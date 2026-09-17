/**
 * Returns a Date object whose LOCAL getters (getHours, getFullYear,
 * getMonth, getDate, getMinutes, ...) reflect India Standard Time wall-clock
 * values, regardless of the host machine/container's own timezone. Every
 * call site in this codebase (bookingController, bookingStatusManager,
 * authController's OTP expiry) relies on exactly that contract via local
 * getters, so this keeps it -- only the way the value is produced changes.
 *
 * The previous implementation round-tripped through
 * `date.toLocaleString(..., { timeZone: 'Asia/Kolkata' })` and reparsed the
 * resulting string with `new Date(...)`. That depends on the exact string
 * format `toLocaleString` produces AND on how `Date`'s string parser reads
 * it back -- both are ICU-version-dependent (Node 20's bundled ICU differs
 * from a newer one), which is exactly the class of bug the "12 oclock" test
 * flakiness in bookingStatusManager.test.js hit. A bad round trip here does
 * not throw; it silently produces a wrong or Invalid Date, and every one of
 * the six call sites above uses the result for a real business decision
 * (OTP expiry, whether a slot is bookable, whether a reschedule is in the
 * past) -- audit #114.
 *
 * `Intl.DateTimeFormat.formatToParts` sidesteps all of that: it returns
 * structured numeric fields directly, no string to reparse. The resulting
 * Date is built with the local (not UTC) constructor precisely so that
 * `.getHours()` etc. hand back exactly these numbers on every host,
 * independent of the container's own timezone.
 */
const IST_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export const getISTDate = (date = new Date()) => {
  const parts = {};
  for (const { type, value } of IST_PARTS.formatToParts(date)) {
    if (type !== 'literal') parts[type] = Number(value);
  }

  return new Date(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
};
