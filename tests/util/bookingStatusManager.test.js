import { jest } from '@jest/globals';

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../../util/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('../../util/notificationHelper.js', () => ({
  createNotification: jest.fn(),
}));

const { default: bookingStatusManager } = await import('../../util/bookingStatusManager.js');

/**
 * parseBookingDateTime is the one place that turns a stored booking's
 * date + time into an absolute instant, which the activation cron then
 * compares against `now` with a tight ±5-minute window.
 *
 * It used `date.setHours(hours, minutes)`, which sets the hour in whatever
 * timezone the NODE PROCESS happens to be running in -- not the customer's
 * IST wall-clock time the booking was actually made in. Nothing in this repo
 * pins TZ=Asia/Kolkata for the deployed container (Cloud Run defaults to
 * UTC), so a booking meant for 8:30 AM IST was being read back as 8:30 AM in
 * whatever the container's local timezone was -- hours away from what the
 * customer picked -- which could land inside, or just outside, the
 * activation window essentially at random depending on deployment
 * environment. A customer reported exactly this: a booking made for 8:30 AM
 * showing as already "ongoing" at 8:05 AM, 25 minutes early.
 */
describe('bookingStatusManager.parseBookingDateTime', () => {
  test('reads booking_time as IST wall-clock time, not process-local time', () => {
    // booking_date as stored: a bare "YYYY-MM-DD" is always parsed as UTC
    // midnight of that day (the date-only ISO rule), regardless of server TZ.
    const result = bookingStatusManager.parseBookingDateTime('2026-08-22', '08:30');

    expect(result).not.toBeNull();
    // The absolute instant must be 8:30 AM IST == 03:00 UTC, full stop --
    // not "8:30 in whatever timezone this test happens to run in".
    expect(result.toISOString()).toBe('2026-08-22T03:00:00.000Z');
  });

  test("the exact reported case: booking at 8:30, 'now' at 8:05, is correctly 25 minutes AWAY, not already reachable", () => {
    const bookingDateTime = bookingStatusManager.parseBookingDateTime('2026-08-22', '08:30');
    const nowIST = new Date(Date.UTC(2026, 7, 22, 8, 5, 0, 0) - (5 * 60 + 30) * 60 * 1000);

    const minutesDiff = (nowIST.getTime() - bookingDateTime.getTime()) / (1000 * 60);

    expect(minutesDiff).toBeCloseTo(-25, 5);
    // The activation cron only fires within [-5, 5]. -25 must stay outside
    // it, i.e. this booking must NOT be pulled into "ongoing" 25 minutes
    // before it starts.
    expect(minutesDiff >= -5 && minutesDiff <= 5).toBe(false);
  });

  test('a booking due right now (within the 5-minute tolerance) is correctly activatable', () => {
    const bookingDateTime = bookingStatusManager.parseBookingDateTime('2026-08-22', '08:30');
    const nowIST = new Date(Date.UTC(2026, 7, 22, 8, 32, 0, 0) - (5 * 60 + 30) * 60 * 1000);

    const minutesDiff = (nowIST.getTime() - bookingDateTime.getTime()) / (1000 * 60);

    expect(minutesDiff >= -5 && minutesDiff <= 5).toBe(true);
  });

  test('midnight IST (00:00) does not roll onto the wrong UTC day', () => {
    const result = bookingStatusManager.parseBookingDateTime('2026-08-22', '00:00');
    // 00:00 IST on Aug 22 is 18:30 UTC on Aug 21 -- the calendar day the
    // customer picked must still read back as Aug 22 in IST.
    expect(result.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).toContain('8/22/2026');
  });

  test('an ISO-format booking_date (with a "T") is handled the same way', () => {
    const result = bookingStatusManager.parseBookingDateTime('2026-08-22T00:00:00.000Z', '08:30');
    expect(result.toISOString()).toBe('2026-08-22T03:00:00.000Z');
  });

  test('missing time defaults to 00:00 IST, not 00:00 in the process timezone', () => {
    const result = bookingStatusManager.parseBookingDateTime('2026-08-22', null);
    expect(result.toISOString()).toBe('2026-08-21T18:30:00.000Z');
  });

  test('returns null for an unparseable date rather than throwing', () => {
    expect(bookingStatusManager.parseBookingDateTime('not-a-date', '08:30')).toBeNull();
    expect(bookingStatusManager.parseBookingDateTime(null, '08:30')).toBeNull();
  });
});
