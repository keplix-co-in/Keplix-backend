/**
 * Edge-case hardening for util/slots.js.
 *
 * Vendor hours are FREE TEXT typed by hand, so every shape below turns up in
 * real data. Nothing here may throw; malformed input must degrade to
 * null/[] ("closed"), never a 500 on the customer's booking screen.
 */
import {
  parseTimeToMinutes,
  parseTimeRange,
  parseJsonArray,
  isHoliday,
  generateSlots,
  minutesToLabel,
  minutesToCanonical,
} from '../../util/slots.js';

describe('parseTimeToMinutes — AM/PM and 24h boundaries', () => {
  test('midnight and noon (the classic AM/PM bugs)', () => {
    expect(parseTimeToMinutes('12:00 AM')).toBe(0);
    expect(parseTimeToMinutes('12:59 AM')).toBe(59);
    expect(parseTimeToMinutes('12:00 PM')).toBe(720);
    expect(parseTimeToMinutes('12:30 AM')).toBe(30);
    expect(parseTimeToMinutes('12 AM')).toBe(0);
    expect(parseTimeToMinutes('12 PM')).toBe(720);
  });

  test('24-hour input is accepted without a meridiem', () => {
    expect(parseTimeToMinutes('10:00')).toBe(600);
    expect(parseTimeToMinutes('20:00')).toBe(1200);
    expect(parseTimeToMinutes('23:59')).toBe(1439);
    expect(parseTimeToMinutes('24:00')).toBeNull();
  });

  test('a 12-hour clock hour of 0 or >12 with a meridiem is rejected', () => {
    expect(parseTimeToMinutes('0:00 AM')).toBeNull();
    expect(parseTimeToMinutes('13:00 PM')).toBeNull();
  });

  test('dotted meridiems and dot separators', () => {
    expect(parseTimeToMinutes('10.30 a.m.')).toBe(630);
    expect(parseTimeToMinutes('7.45 p.m.')).toBe(1185);
  });

  test('label/canonical round-trip across noon and midnight', () => {
    expect(minutesToLabel(0)).toBe('12:00 AM');
    expect(minutesToLabel(720)).toBe('12:00 PM');
    expect(minutesToLabel(1439)).toBe('11:59 PM');
    expect(minutesToCanonical(0)).toBe('00:00');
    expect(minutesToCanonical(720)).toBe('12:00');
    expect(minutesToLabel(1440)).toBeNull();
    expect(minutesToLabel(-1)).toBeNull();
    expect(minutesToLabel(NaN)).toBeNull();
    expect(minutesToCanonical('x')).toBeNull();
  });
});

describe('parseTimeRange — messy real-world hours', () => {
  test('empty-ish input never throws and yields null', () => {
    for (const bad of ['', '   ', null, undefined, 0, {}, [], NaN]) {
      expect(() => parseTimeRange(bad)).not.toThrow();
      expect(parseTimeRange(bad)).toBeNull();
    }
  });

  test('missing separator yields null', () => {
    expect(parseTimeRange('10:00 AM')).toBeNull();
    expect(parseTimeRange('10:00')).toBeNull();
  });

  test('"to" is accepted as a separator', () => {
    expect(parseTimeRange('10am to 8pm')).toEqual({ start: 600, end: 1200 });
    expect(parseTimeRange('10:00 AM to 8:00 PM')).toEqual({ start: 600, end: 1200 });
  });

  test('24-hour ranges', () => {
    expect(parseTimeRange('10:00 - 20:00')).toEqual({ start: 600, end: 1200 });
  });

  test('inverted range (close before open) is unparseable, not an overnight shift', () => {
    expect(parseTimeRange('8:00 PM - 10:00 AM')).toBeNull();
  });

  test('open == close is unparseable (a zero-length day has no slots)', () => {
    expect(parseTimeRange('10:00 AM - 10:00 AM')).toBeNull();
  });
});

describe('parseJsonArray — the breaks/holidays column coercion', () => {
  test('every shape the column can hold is tolerated', () => {
    expect(parseJsonArray(null)).toEqual([]);
    expect(parseJsonArray(undefined)).toEqual([]);
    expect(parseJsonArray('')).toEqual([]);
    expect(parseJsonArray('    ')).toEqual([]);
    expect(parseJsonArray(42)).toEqual([]);
    expect(parseJsonArray({ a: 1 })).toEqual([]);
    expect(parseJsonArray('{"a":1}')).toEqual([]); // valid JSON, not an array
    expect(parseJsonArray(['1:00 PM - 2:00 PM'])).toEqual(['1:00 PM - 2:00 PM']);
    expect(parseJsonArray('["1:00 PM - 2:00 PM"]')).toEqual(['1:00 PM - 2:00 PM']);
    expect(parseJsonArray('1 PM - 2 PM, 5 PM - 6 PM')).toEqual(['1 PM - 2 PM', ' 5 PM - 6 PM']);
    expect(parseJsonArray('1 PM - 2 PM')).toEqual(['1 PM - 2 PM']);
  });

  test('malformed JSON never throws', () => {
    expect(() => parseJsonArray('["1 PM - 2 PM"')).not.toThrow();
    expect(Array.isArray(parseJsonArray('["1 PM - 2 PM"'))).toBe(true);
    expect(() => parseJsonArray('[{')).not.toThrow();
    expect(Array.isArray(parseJsonArray('[{'))).toBe(true);
  });
});

describe('generateSlots — break geometry', () => {
  test('a break aligned exactly to slot boundaries removes exactly those slots', () => {
    const slots = generateSlots({
      operating_hours: '12:00 PM - 3:00 PM',
      breaks: ['1:00 PM - 1:30 PM'],
    });
    expect(slots.map((s) => s.time)).toEqual(['12:00', '12:30', '13:30', '14:00', '14:30']);
  });

  test('a break straddling a boundary (13:15-13:45) removes BOTH 13:00 and 13:30', () => {
    const slots = generateSlots({
      operating_hours: '12:00 PM - 3:00 PM',
      breaks: ['1:15 PM - 1:45 PM'],
    });
    expect(slots.map((s) => s.time)).toEqual(['12:00', '12:30', '14:00', '14:30']);
  });

  test('a break covering the whole day leaves no slots', () => {
    expect(
      generateSlots({ operating_hours: '10:00 AM - 6:00 PM', breaks: ['12:00 AM - 11:59 PM'] })
    ).toEqual([]);
  });

  test('a break starting before opening only clips the front', () => {
    const slots = generateSlots({
      operating_hours: '10:00 AM - 12:00 PM',
      breaks: ['8:00 AM - 10:30 AM'],
    });
    expect(slots.map((s) => s.time)).toEqual(['10:30', '11:00', '11:30']);
  });

  test('a break extending past closing only clips the tail', () => {
    const slots = generateSlots({
      operating_hours: '10:00 AM - 12:00 PM',
      breaks: ['11:00 AM - 11:00 PM'],
    });
    expect(slots.map((s) => s.time)).toEqual(['10:00', '10:30']);
  });

  test('breaks as a bare comma-separated string are honoured', () => {
    const slots = generateSlots({
      operating_hours: '12:00 PM - 3:00 PM',
      breaks: '12:30 PM - 1:00 PM, 2:00 PM - 2:30 PM',
    });
    expect(slots.map((s) => s.time)).toEqual(['12:00', '13:00', '13:30', '14:30']);
  });

  test('every malformed hours shape returns [] without throwing', () => {
    for (const bad of ['', '   ', null, undefined, '10am to', '10:00 AM', 5, {}, []]) {
      expect(() => generateSlots({ operating_hours: bad })).not.toThrow();
      expect(generateSlots({ operating_hours: bad })).toEqual([]);
    }
    expect(generateSlots({ operating_hours: '8:00 PM - 10:00 AM' })).toEqual([]);
    expect(generateSlots({ operating_hours: '10:00 AM - 10:00 AM' })).toEqual([]);
    expect(generateSlots(null)).toEqual([]);
    expect(generateSlots(undefined)).toEqual([]);
  });

  test('junk breaks are skipped, good ones still applied', () => {
    for (const bad of [null, undefined, 5, {}, 'not json', '{"a":1}', [null, 'junk', 5]]) {
      expect(() =>
        generateSlots({ operating_hours: '10:00 AM - 11:00 AM', breaks: bad })
      ).not.toThrow();
      expect(
        generateSlots({ operating_hours: '10:00 AM - 11:00 AM', breaks: bad }).map((s) => s.time)
      ).toEqual(['10:00', '10:30']);
    }
  });

  test('no slot ever runs past closing time', () => {
    // 10:00-11:20 — an 11:00 slot would end at 11:30, past close.
    expect(generateSlots({ operating_hours: '10:00 - 11:20' }).map((s) => s.time)).toEqual([
      '10:00',
      '10:30',
    ]);
  });

  test('slots spanning noon carry correct AM/PM labels', () => {
    expect(generateSlots({ operating_hours: '11:00 - 13:00' }).map((s) => s.label)).toEqual([
      '11:00 AM',
      '11:30 AM',
      '12:00 PM',
      '12:30 PM',
    ]);
  });

  test('a midnight-open day starts at 12:00 AM', () => {
    const slots = generateSlots({ operating_hours: '12:00 AM - 1:00 AM' });
    expect(slots).toEqual([
      { time: '00:00', label: '12:00 AM' },
      { time: '00:30', label: '12:30 AM' },
    ]);
  });
});

describe('isHoliday', () => {
  test('matches case- and whitespace-insensitively across every container shape', () => {
    expect(isHoliday(JSON.stringify(['Sunday']), 'sunday')).toBe(true);
    expect(isHoliday(JSON.stringify(['sunday']), 'Sunday')).toBe(true);
    expect(isHoliday(['  SUNDAY  '], 'Sunday')).toBe(true);
    expect(isHoliday('Sunday', 'Sunday')).toBe(true);
    expect(isHoliday('Sunday, Monday', 'Monday')).toBe(true);
    expect(isHoliday(JSON.stringify(['Sunday']), 'Monday')).toBe(false);
  });

  test('junk holidays never throw and never mark a day closed', () => {
    for (const bad of [null, undefined, '', '   ', 42, {}, [null, 5, {}]]) {
      expect(() => isHoliday(bad, 'Sunday')).not.toThrow();
      expect(isHoliday(bad, 'Sunday')).toBe(false);
    }
    expect(isHoliday(['Sunday'], null)).toBe(false);
  });
});
