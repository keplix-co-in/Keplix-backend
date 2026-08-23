import {
  parseTimeToMinutes,
  parseTimeRange,
  toCanonicalTime,
  generateSlots,
} from '../../util/slots.js';

describe('parseTimeToMinutes', () => {
  test('parses 12-hour times', () => {
    expect(parseTimeToMinutes('10:00 AM')).toBe(600);
    expect(parseTimeToMinutes('8:00 PM')).toBe(1200);
    expect(parseTimeToMinutes('12:00 AM')).toBe(0);
    expect(parseTimeToMinutes('12:30 PM')).toBe(750);
    expect(parseTimeToMinutes('9:15am')).toBe(555);
  });

  test('parses 24-hour times', () => {
    expect(parseTimeToMinutes('14:00')).toBe(840);
    expect(parseTimeToMinutes('00:00')).toBe(0);
  });

  test('returns null for malformed input instead of throwing', () => {
    for (const bad of [null, undefined, '', '   ', 'lunchtime', '25:00', '10:75', {}, 42, '10:00 XM']) {
      expect(parseTimeToMinutes(bad)).toBeNull();
    }
  });
});

describe('parseTimeRange', () => {
  test('parses a range', () => {
    expect(parseTimeRange('10:00 AM - 8:00 PM')).toEqual({ start: 600, end: 1200 });
    expect(parseTimeRange('1:00 PM–2:00 PM')).toEqual({ start: 780, end: 840 });
  });

  test('returns null when malformed or inverted', () => {
    expect(parseTimeRange('10:00 AM')).toBeNull();
    expect(parseTimeRange('8:00 PM - 10:00 AM')).toBeNull();
    expect(parseTimeRange(null)).toBeNull();
    expect(parseTimeRange('nonsense - nonsense')).toBeNull();
  });
});

describe('toCanonicalTime', () => {
  test('normalises legacy formats to 24h HH:mm', () => {
    expect(toCanonicalTime('2:00 PM')).toBe('14:00');
    expect(toCanonicalTime('10:00 AM')).toBe('10:00');
    expect(toCanonicalTime('14:00')).toBe('14:00');
    expect(toCanonicalTime('9:5 am')).toBe('09:05');
  });

  test('returns null for junk', () => {
    expect(toCanonicalTime('later')).toBeNull();
    expect(toCanonicalTime(undefined)).toBeNull();
  });
});

describe('generateSlots', () => {
  test('generates 30-minute slots between open and close', () => {
    const slots = generateSlots({ operating_hours: '10:00 AM - 12:00 PM' });
    expect(slots.map((s) => s.time)).toEqual(['10:00', '10:30', '11:00', '11:30']);
    expect(slots[0]).toEqual({ time: '10:00', label: '10:00 AM' });
    expect(slots[3].label).toBe('11:30 AM');
  });

  test('excludes slots that fall inside a break', () => {
    const slots = generateSlots({
      operating_hours: '12:00 PM - 3:00 PM',
      breaks: ['1:00 PM - 2:00 PM'],
    });
    expect(slots.map((s) => s.time)).toEqual(['12:00', '12:30', '14:00', '14:30']);
  });

  test('accepts breaks as a JSON string', () => {
    const slots = generateSlots({
      operating_hours: '12:00 PM - 2:00 PM',
      breaks: JSON.stringify(['12:30 PM - 1:00 PM']),
    });
    expect(slots.map((s) => s.time)).toEqual(['12:00', '13:00', '13:30']);
  });

  test('malformed or missing input returns [] rather than throwing', () => {
    expect(generateSlots({})).toEqual([]);
    expect(generateSlots()).toEqual([]);
    expect(generateSlots({ operating_hours: 'always open' })).toEqual([]);
    expect(generateSlots({ operating_hours: null, breaks: 'not json' })).toEqual([]);
    expect(
      generateSlots({ operating_hours: '10:00 AM - 11:00 AM', breaks: 'not json' }).map((s) => s.time)
    ).toEqual(['10:00', '10:30']);
    expect(
      generateSlots({ operating_hours: '10:00 AM - 11:00 AM', breaks: [null, 'junk', 5] }).map((s) => s.time)
    ).toEqual(['10:00', '10:30']);
  });
});
