/**
 * Regression test for audit #114: getISTDate round-tripped through
 * toLocaleString + Date reparsing, which is ICU-version-dependent and
 * silently produced a wrong or Invalid Date. Rewritten with
 * Intl.DateTimeFormat.formatToParts (see util/time.js for the full
 * explanation).
 */
import { getISTDate } from '../../util/time.js';

describe('getISTDate', () => {
  test('reflects IST wall-clock fields via local getters', () => {
    // 2026-09-15T00:00:00Z is 2026-09-15 05:30:00 IST (UTC+5:30).
    const utcMidnight = new Date('2026-09-15T00:00:00.000Z');
    const ist = getISTDate(utcMidnight);

    expect(ist.getFullYear()).toBe(2026);
    expect(ist.getMonth()).toBe(8); // September, 0-indexed
    expect(ist.getDate()).toBe(15);
    expect(ist.getHours()).toBe(5);
    expect(ist.getMinutes()).toBe(30);
  });

  test('rolls the date forward correctly across the IST midnight boundary', () => {
    // 2026-09-14T19:00:00Z is 2026-09-15T00:30:00 IST -- one day later.
    const utc = new Date('2026-09-14T19:00:00.000Z');
    const ist = getISTDate(utc);

    expect(ist.getDate()).toBe(15);
    expect(ist.getHours()).toBe(0);
    expect(ist.getMinutes()).toBe(30);
  });

  test('the two 12 oclock edge cases (audit #114 / the h23 ICU issue, one level down)', () => {
    // 2026-09-14T18:30:00Z is 2026-09-15T00:00:00 IST -- midnight, not 24:00.
    const midnight = getISTDate(new Date('2026-09-14T18:30:00.000Z'));
    expect(midnight.getHours()).toBe(0);

    // 2026-09-15T06:30:00Z is 2026-09-15T12:00:00 IST -- noon.
    const noon = getISTDate(new Date('2026-09-15T06:30:00.000Z'));
    expect(noon.getHours()).toBe(12);
  });

  test('defaults to the current time when called with no argument', () => {
    const before = Date.now();
    const ist = getISTDate();
    // The IST wall-clock Date's own epoch is host-timezone-shifted by
    // design (see util/time.js) -- what this test can actually assert
    // without knowing the host's timezone is that it didn't throw and
    // returned a valid Date close to "now" in absolute terms modulo the
    // IST/local offset, which is bounded by 14 hours either way.
    const after = Date.now();
    expect(ist instanceof Date).toBe(true);
    expect(Number.isNaN(ist.getTime())).toBe(false);
    expect(Math.abs(ist.getTime() - before)).toBeLessThan(14 * 60 * 60 * 1000 + 5000);
    expect(after).toBeGreaterThanOrEqual(before);
  });
});
