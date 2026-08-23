import { jest } from '@jest/globals';
import {
  notificationTemplates,
  NOTIFICATION_TYPES,
  renderNotification,
  previewText,
  formatAmount,
  statusPhrase,
  serviceName,
} from '../../util/notificationTemplates.js';

const ALL_TYPES = Object.keys(notificationTemplates);

// Every shape a real call site can accidentally hand a template.
const HOSTILE_VARS = [
  undefined,
  null,
  {},
  {
    serviceName: undefined,
    customerName: null,
    amount: undefined,
    bookingId: null,
    status: undefined,
    messageText: null,
    bookingDate: undefined,
    requestedTimeLabel: null,
    etaText: undefined,
  },
  {
    serviceName: null,
    customerName: undefined,
    amount: NaN,
    bookingId: undefined,
    status: 'some_unmapped_enum_value',
    messageText: '',
    bookingDate: 'not-a-date',
    requestedTimeLabel: '',
    etaText: '',
  },
  {
    serviceName: '   ',
    amount: 'not-a-number',
    bookingDate: null,
    status: '',
  },
];

const FULL_VARS = {
  serviceName: 'Full Body Wash',
  customerName: 'Asha Menon',
  amount: 1250.5,
  bookingId: 42,
  paymentId: 7,
  status: 'service_completed',
  messageText: 'Can you please check the brake pads on the front left wheel as well',
  senderName: 'Asha Menon',
  conversationId: 11,
  bookingDate: '2026-09-01T10:00:00.000Z',
  requestedTime: '10:30',
  requestedTimeLabel: '10:30 AM',
  etaText: 'in 5-7 business days',
};

const BANNED = ['undefined', 'null', 'NaN', '[object Object]'];

describe('notificationTemplates registry', () => {
  it('exposes a template for every declared type constant', () => {
    for (const type of Object.values(NOTIFICATION_TYPES)) {
      expect(typeof notificationTemplates[type]).toBe('function');
    }
    expect(ALL_TYPES.length).toBe(Object.values(NOTIFICATION_TYPES).length);
  });

  it.each(ALL_TYPES)('%s renders a complete notification with full data', (type) => {
    const n = renderNotification(type, FULL_VARS);

    expect(typeof n.type).toBe('string');
    expect(n.type.length).toBeGreaterThan(0);
    expect(n.type).toBe(type);

    expect(typeof n.title).toBe('string');
    expect(n.title.trim().length).toBeGreaterThan(0);

    expect(typeof n.body).toBe('string');
    expect(n.body.trim().length).toBeGreaterThan(0);

    expect(n.data).toBeTruthy();
    expect(n.data.type).toBe(type);
  });

  it.each(ALL_TYPES)('%s never emits placeholder junk, whatever the vars', (type) => {
    for (const vars of [FULL_VARS, ...HOSTILE_VARS]) {
      const n = renderNotification(type, vars);
      for (const banned of BANNED) {
        expect(n.title).not.toContain(banned);
        expect(n.body).not.toContain(banned);
      }
      expect(n.title.trim().length).toBeGreaterThan(0);
      expect(n.body.trim().length).toBeGreaterThan(0);
    }
  });

  it.each(ALL_TYPES)('%s renders with no argument at all', (type) => {
    const n = notificationTemplates[type]();
    expect(n.title.trim().length).toBeGreaterThan(0);
    expect(n.body.trim().length).toBeGreaterThan(0);
    for (const banned of BANNED) {
      expect(`${n.title} ${n.body}`).not.toContain(banned);
    }
  });
});

describe('copy rules', () => {
  it('uses sentence case titles with no emoji and no exclamation marks', () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    for (const type of ALL_TYPES) {
      const { title } = renderNotification(type, FULL_VARS);
      expect(title).not.toMatch(emoji);
      expect(title).not.toContain('!');
      // Sentence case: first character upper, and no ALL-CAPS shouting.
      expect(title[0]).toBe(title[0].toUpperCase());
      expect(title).not.toBe(title.toUpperCase());
    }
  });

  it('gives every event a distinct title', () => {
    const titles = ALL_TYPES.map((t) => renderNotification(t, FULL_VARS).title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('gives the three former "Booking Cancelled" events three different titles', () => {
    const byCustomer = renderNotification(
      NOTIFICATION_TYPES.BOOKING_CANCELLED_BY_CUSTOMER, FULL_VARS).title;
    const byVendor = renderNotification(
      NOTIFICATION_TYPES.BOOKING_CANCELLED_BY_VENDOR, FULL_VARS).title;
    const underReview = renderNotification(
      NOTIFICATION_TYPES.REFUND_UNDER_REVIEW, FULL_VARS).title;
    expect(new Set([byCustomer, byVendor, underReview]).size).toBe(3);
  });

  it('carries a tap-to-navigate payload on every booking template', () => {
    for (const type of ALL_TYPES) {
      const { data } = renderNotification(type, FULL_VARS);
      const navigable =
        data.bookingId !== undefined ||
        data.conversationId !== undefined ||
        data.screen !== undefined;
      expect(navigable).toBe(true);
    }
  });

  it('omits missing ids from the payload rather than sending nulls', () => {
    const { data } = renderNotification(NOTIFICATION_TYPES.SERVICE_STARTED, {});
    expect('bookingId' in data).toBe(false);
    expect(data.type).toBe(NOTIFICATION_TYPES.SERVICE_STARTED);
  });

  it('throws on an unknown template type instead of sending nothing', () => {
    expect(() => renderNotification('NOT_A_REAL_TYPE', {})).toThrow(/Unknown notification template/);
  });
});

describe('guarded interpolation helpers', () => {
  it('formatAmount returns an Indian-grouped amount or an empty string', () => {
    expect(formatAmount(1250)).toBe('₹1,250');
    expect(formatAmount('1250')).toBe('₹1,250');
    expect(formatAmount(undefined)).toBe('');
    expect(formatAmount(null)).toBe('');
    expect(formatAmount(NaN)).toBe('');
    expect(formatAmount('abc')).toBe('');
    expect(formatAmount({})).toBe('');
  });

  it('statusPhrase never leaks a raw enum value', () => {
    expect(statusPhrase('service_completed')).not.toContain('_');
    expect(statusPhrase('in_progress')).toBe('in progress');
    expect(statusPhrase('totally_unknown')).toBe('');
    expect(statusPhrase(undefined)).toBe('');
  });

  it('serviceName falls back to neutral wording', () => {
    expect(serviceName('Oil Change')).toBe('Oil Change');
    expect(serviceName(undefined)).toBe('your service');
    expect(serviceName('  ')).toBe('your service');
  });

  it('previewText truncates on a word boundary', () => {
    const long = 'Can you please check the brake pads on the front left wheel as well';
    const preview = previewText(long);
    expect(preview.endsWith('...')).toBe(true);
    // The old slice(0, 50) cut mid-word ("...on the fro"); the boundary version
    // must stop where a space follows in the original text.
    const kept = preview.replace(/\.\.\.$/, '');
    expect(long.startsWith(kept)).toBe(true);
    expect(long[kept.length]).toBe(' ');
    expect(preview.length).toBeLessThanOrEqual(53);
  });

  it('previewText leaves short messages untouched and collapses whitespace', () => {
    expect(previewText('See you soon')).toBe('See you soon');
    expect(previewText('line one\nline two')).toBe('line one line two');
    expect(previewText(undefined)).toBe('');
  });

  it('falls back to generic chat copy when the message body is unusable', () => {
    const n = renderNotification(NOTIFICATION_TYPES.NEW_MESSAGE, { conversationId: 3 });
    expect(n.body).toBe('You have a new message about your booking.');
    expect(n.data.conversationId).toBe(3);
  });
});

describe('status and money copy at the real call sites', () => {
  it('BOOKING_STATUS_UPDATED never renders the raw status enum', () => {
    const n = renderNotification(NOTIFICATION_TYPES.BOOKING_STATUS_UPDATED, {
      serviceName: 'Oil Change',
      status: 'service_completed',
      bookingId: 1,
    });
    expect(n.body).not.toContain('service_completed');
    expect(n.body).toContain('completed by the workshop');
  });

  it('BOOKING_STATUS_UPDATED words the sentence without the status when unknown', () => {
    const n = renderNotification(NOTIFICATION_TYPES.BOOKING_STATUS_UPDATED, {
      serviceName: 'Oil Change',
      status: 'weird_new_enum',
    });
    expect(n.body).toBe('Your booking for Oil Change has been updated.');
  });

  it('PAYOUT_SETTLED drops the amount clause instead of printing an empty amount', () => {
    const withAmount = renderNotification(NOTIFICATION_TYPES.PAYOUT_SETTLED, {
      amount: 2400, serviceName: 'Oil Change',
    });
    expect(withAmount.body).toContain('₹2,400');

    const without = renderNotification(NOTIFICATION_TYPES.PAYOUT_SETTLED, {
      amount: null, serviceName: 'Oil Change',
    });
    expect(without.body).not.toContain('₹');
    expect(without.body).toContain('Oil Change');
  });

  it('REFUND_UNDER_REVIEW quotes no amount at all', () => {
    const n = renderNotification(NOTIFICATION_TYPES.REFUND_UNDER_REVIEW, { amount: 999 });
    expect(n.body).not.toContain('₹');
    expect(n.body).not.toContain('999');
  });
});
