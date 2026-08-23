/**
 * notificationTemplates.js
 *
 * One entry per notification event. Every entry is keyed by a stable type
 * constant and renders `{ type, title, body, data }` from a plain variables
 * object.
 *
 * Why this file exists:
 *  - The copy used to live inline at ~25 call sites, so the same event could be
 *    worded three different ways and nobody could read the whole set.
 *  - Three separate events all rendered the title "Booking Cancelled", so a
 *    customer whose booking a vendor cancelled and a vendor whose customer
 *    cancelled saw identical notifications.
 *  - Interpolations were unguarded: `₹${payment.vendorAmount}` rendered
 *    "₹undefined" whenever the column was null, and
 *    `is now ${status}` leaked the raw enum ("is now service_completed").
 *
 * Rules every template here follows:
 *  - Sentence case titles, no emoji, no exclamation marks, one consistent voice.
 *  - No interpolation can ever produce the literal text "undefined", "null" or
 *    "NaN". Missing values either fall back to neutral wording or the clause
 *    containing them is dropped entirely.
 *  - No raw enum value is ever shown to a human.
 *  - `data` always carries enough for tap-to-navigate (type + bookingId /
 *    conversationId), because both apps route the tap off `data`.
 */

// ---------------------------------------------------------------------------
// Type constants
// ---------------------------------------------------------------------------

export const NOTIFICATION_TYPES = {
  // Booking lifecycle -- customer facing
  BOOKING_REQUEST_ACCEPTED: 'BOOKING_REQUEST_ACCEPTED',
  BOOKING_REQUEST_DECLINED: 'BOOKING_REQUEST_DECLINED',
  BOOKING_STATUS_UPDATED: 'BOOKING_STATUS_UPDATED',
  BOOKING_CONFIRMED: 'BOOKING_CONFIRMED',
  SERVICE_COMPLETED: 'SERVICE_COMPLETED',
  BOOKING_CANCELLED_BY_VENDOR: 'BOOKING_CANCELLED_BY_VENDOR',
  BOOKING_AUTO_DECLINED: 'BOOKING_AUTO_DECLINED',
  SERVICE_STARTED: 'SERVICE_STARTED',
  BOOKING_EXPIRED: 'BOOKING_EXPIRED',

  // Booking lifecycle -- vendor facing
  NEW_BOOKING_ALERT: 'NEW_BOOKING_ALERT',
  BOOKING_CANCELLED_BY_CUSTOMER: 'BOOKING_CANCELLED_BY_CUSTOMER',
  BOOKING_REQUEST_EXPIRED: 'BOOKING_REQUEST_EXPIRED',
  SERVICE_TIME_ARRIVED: 'SERVICE_TIME_ARRIVED',
  BOOKING_MISSED_EXPIRED: 'BOOKING_MISSED_EXPIRED',

  // Money
  PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
  PAYOUT_SETTLED: 'PAYOUT_SETTLED',
  REFUND_ISSUED: 'REFUND_ISSUED',
  REFUND_UNDER_REVIEW: 'REFUND_UNDER_REVIEW',

  // Early start
  EARLY_START_REQUEST: 'EARLY_START_REQUEST',
  EARLY_START_DECLINED: 'EARLY_START_DECLINED',
  EARLY_START_ACCEPTED: 'EARLY_START_ACCEPTED',

  // Chat
  NEW_MESSAGE: 'NEW_MESSAGE',

  // Dispute
  SERVICE_DISPUTED: 'SERVICE_DISPUTED',
};

// ---------------------------------------------------------------------------
// Guarded interpolation helpers
//
// Every one of these is total: given anything at all (including undefined,
// null, NaN, {} or []) it returns a string that is safe to show a human.
// ---------------------------------------------------------------------------

/** Trimmed string, or '' for anything that is not usable text. */
const text = (value) => {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
};

/**
 * Service name for a standalone position ("your booking for X"), with a neutral
 * fallback -- never "undefined".
 */
export const serviceName = (value) => text(value) || 'your service';

/**
 * Service name for a position that already has an article or possessive in
 * front of it ("Your X booking", "the X booking"). The fallback is the bare
 * noun so the sentence does not read "Your your service booking".
 */
export const serviceNoun = (value) => text(value) || 'service';

/** Customer name with a neutral fallback. */
const customerName = (value) => text(value) || 'A customer';

/**
 * "₹1,20,000" for a finite, non-negative number; '' for anything else.
 *
 * Returning '' rather than a placeholder is deliberate: callers drop the whole
 * clause when there is no amount, because inventing "₹0" would be a lie about
 * money.
 */
export const formatAmount = (value) => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  return `₹${n.toLocaleString('en-IN')}`;
};

/** Locale date string, or '' if the input is not a real date. */
const formatDate = (value) => {
  if (value === null || value === undefined || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN');
};

/**
 * Human phrase for a booking status enum. Never leaks the raw value: an
 * unrecognised or missing status returns '' and the caller words the sentence
 * without it.
 */
const STATUS_PHRASES = {
  pending: 'awaiting confirmation',
  confirmed: 'confirmed',
  accepted: 'confirmed',
  in_progress: 'in progress',
  service_completed: 'completed by the workshop, awaiting your confirmation',
  completed: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  rejected: 'declined',
  expired: 'expired',
  disputed: 'under review',
};

export const statusPhrase = (status) => STATUS_PHRASES[text(status).toLowerCase()] || '';

/**
 * Truncate a chat message for a push preview on a word boundary.
 *
 * `message_text.slice(0, 50)` used to cut mid-word ("Can you check the brake
 * pads on the fro"). This backs up to the last space instead and appends an
 * ellipsis, and collapses newlines so a multi-line message stays one line.
 */
export const previewText = (value, maxLength = 50) => {
  const raw = text(value).replace(/\s+/g, ' ');
  if (!raw) return '';
  if (raw.length <= maxLength) return raw;
  const clipped = raw.slice(0, maxLength);
  const lastSpace = clipped.lastIndexOf(' ');
  // Only honour the word boundary if it leaves a sensible amount of text --
  // a single very long word would otherwise truncate to nothing.
  const base = lastSpace > maxLength * 0.5 ? clipped.slice(0, lastSpace) : clipped;
  return `${base.replace(/[\s.,;:!?-]+$/, '')}...`;
};

/** Join sentence fragments, dropping empty ones, into one clean string. */
const join = (...parts) => parts.filter((p) => text(p) !== '').join(' ');

/** Strip undefined/null entries so they never reach the push payload. */
const payload = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
};

const bookingData = (type, vars = {}, extra = {}) =>
  payload({
    type,
    bookingId: vars.bookingId ?? null,
    ...extra,
  });

const T = NOTIFICATION_TYPES;

// ---------------------------------------------------------------------------
// The registry
//
// Each value is (vars) => { type, title, body, data }. Calling any of them with
// no arguments at all must still produce readable copy -- that is asserted in
// tests/util/notificationTemplates.test.js.
// ---------------------------------------------------------------------------

export const notificationTemplates = {
  // --- Booking lifecycle: customer facing ---------------------------------

  [T.BOOKING_REQUEST_ACCEPTED]: (v = {}) => ({
    type: T.BOOKING_REQUEST_ACCEPTED,
    title: 'Request accepted',
    body: `Your ${serviceNoun(v.serviceName)} request was accepted. You can now complete the payment.`,
    data: bookingData(T.BOOKING_REQUEST_ACCEPTED, v),
  }),

  [T.BOOKING_REQUEST_DECLINED]: (v = {}) => ({
    type: T.BOOKING_REQUEST_DECLINED,
    title: 'Request declined',
    body: `Your ${serviceNoun(v.serviceName)} request was declined by the workshop. You can book another provider.`,
    data: bookingData(T.BOOKING_REQUEST_DECLINED, v),
  }),

  [T.BOOKING_STATUS_UPDATED]: (v = {}) => {
    const phrase = statusPhrase(v.status);
    return {
      type: T.BOOKING_STATUS_UPDATED,
      title: 'Booking updated',
      body: phrase
        ? `Your booking for ${serviceName(v.serviceName)} is now ${phrase}.`
        : `Your booking for ${serviceName(v.serviceName)} has been updated.`,
      data: bookingData(T.BOOKING_STATUS_UPDATED, v, { status: text(v.status) || null }),
    };
  },

  [T.BOOKING_CONFIRMED]: (v = {}) => ({
    type: T.BOOKING_CONFIRMED,
    title: 'Booking confirmed',
    body: `The workshop accepted your booking for ${serviceName(v.serviceName)}.`,
    data: bookingData(T.BOOKING_CONFIRMED, v),
  }),

  [T.SERVICE_COMPLETED]: (v = {}) => ({
    type: T.SERVICE_COMPLETED,
    title: 'Service completed',
    body: `The workshop marked ${serviceName(v.serviceName)} as completed. Confirm it to release the payment.`,
    data: bookingData(T.SERVICE_COMPLETED, v),
  }),

  [T.BOOKING_CANCELLED_BY_VENDOR]: (v = {}) => ({
    type: T.BOOKING_CANCELLED_BY_VENDOR,
    title: 'Booking cancelled by the workshop',
    body: `Your booking for ${serviceName(v.serviceName)} was cancelled by the workshop.`,
    data: bookingData(T.BOOKING_CANCELLED_BY_VENDOR, v),
  }),

  [T.BOOKING_AUTO_DECLINED]: (v = {}) => ({
    type: T.BOOKING_AUTO_DECLINED,
    title: 'Request timed out',
    body: `Your booking request for ${serviceName(v.serviceName)} was not accepted in time, so it has been declined automatically.`,
    data: bookingData(T.BOOKING_AUTO_DECLINED, v),
  }),

  [T.SERVICE_STARTED]: (v = {}) => ({
    type: T.SERVICE_STARTED,
    title: 'Service started',
    body: `Work has started on your ${serviceNoun(v.serviceName)} booking.`,
    data: bookingData(T.SERVICE_STARTED, v),
  }),

  [T.BOOKING_EXPIRED]: (v = {}) => ({
    type: T.BOOKING_EXPIRED,
    title: 'Booking expired',
    body: `Your ${serviceNoun(v.serviceName)} booking expired because the scheduled time passed without the service starting.`,
    data: bookingData(T.BOOKING_EXPIRED, v),
  }),

  // --- Booking lifecycle: vendor facing -----------------------------------

  [T.NEW_BOOKING_ALERT]: (v = {}) => {
    const on = formatDate(v.bookingDate);
    return {
      type: T.NEW_BOOKING_ALERT,
      title: 'New service request',
      body: on
        ? `${customerName(v.customerName)} requested ${serviceName(v.serviceName)} for ${on}.`
        : `${customerName(v.customerName)} requested ${serviceName(v.serviceName)}.`,
      data: bookingData(T.NEW_BOOKING_ALERT, v),
    };
  },

  [T.BOOKING_CANCELLED_BY_CUSTOMER]: (v = {}) => ({
    type: T.BOOKING_CANCELLED_BY_CUSTOMER,
    title: 'Booking cancelled by the customer',
    body: `The ${serviceNoun(v.serviceName)} booking was cancelled by the customer.`,
    data: bookingData(T.BOOKING_CANCELLED_BY_CUSTOMER, v),
  }),

  [T.BOOKING_REQUEST_EXPIRED]: (v = {}) => ({
    type: T.BOOKING_REQUEST_EXPIRED,
    title: 'Booking request expired',
    body: `You missed a booking request for ${serviceName(v.serviceName)}. It has been declined automatically.`,
    data: bookingData(T.BOOKING_REQUEST_EXPIRED, v),
  }),

  [T.SERVICE_TIME_ARRIVED]: (v = {}) => ({
    type: T.SERVICE_TIME_ARRIVED,
    title: 'Service time arrived',
    body: `It is time to start the ${serviceNoun(v.serviceName)} booking.`,
    data: bookingData(T.SERVICE_TIME_ARRIVED, v),
  }),

  [T.BOOKING_MISSED_EXPIRED]: (v = {}) => ({
    type: T.BOOKING_MISSED_EXPIRED,
    title: 'Missed booking expired',
    body: `The ${serviceNoun(v.serviceName)} booking expired because the scheduled time was missed.`,
    data: bookingData(T.BOOKING_MISSED_EXPIRED, v),
  }),

  // --- Money ---------------------------------------------------------------

  [T.PAYMENT_RECEIVED]: (v = {}) => ({
    type: T.PAYMENT_RECEIVED,
    title: 'Payment received',
    body: `A customer has paid for ${serviceName(v.serviceName)}. You can now start the service.`,
    data: bookingData(T.PAYMENT_RECEIVED, v),
  }),

  [T.PAYOUT_SETTLED]: (v = {}) => {
    const amount = formatAmount(v.amount);
    return {
      type: T.PAYOUT_SETTLED,
      title: 'Payout sent',
      body: amount
        ? `${amount} has been transferred to your account for ${serviceName(v.serviceName)}.`
        : `Your payout for ${serviceName(v.serviceName)} has been transferred to your account.`,
      data: bookingData(T.PAYOUT_SETTLED, v, { paymentId: v.paymentId ?? null }),
    };
  },

  [T.REFUND_ISSUED]: (v = {}) => {
    const amount = formatAmount(v.amount);
    const eta = text(v.etaText);
    const subject = amount
      ? `${amount} for your cancelled booking`
      : 'The refund for your cancelled booking';
    const tail = eta
      ? ` and should appear ${eta}.`
      : '.';
    return {
      type: T.REFUND_ISSUED,
      title: 'Refund on its way',
      body: `${subject} is on its way back to your original payment method${tail}`,
      data: bookingData(T.REFUND_ISSUED, v, {
        // The tap target is the cancelled tab of the booking list, not
        // BookingDetails: that screen renders null when given only an id.
        screen: 'BookingList',
        params: { initialTab: 'cancelled' },
      }),
    };
  },

  [T.REFUND_UNDER_REVIEW]: (v = {}) => ({
    type: T.REFUND_UNDER_REVIEW,
    title: 'Refund under review',
    // Deliberately quotes no amount: a late cancellation has not been approved
    // for any particular refund yet, and promising a number here would be one.
    body: 'Your booking is cancelled. Our team is reviewing your refund and will contact you shortly.',
    data: bookingData(T.REFUND_UNDER_REVIEW, v, {
      screen: 'BookingList',
      params: { initialTab: 'cancelled' },
    }),
  }),

  // --- Early start ---------------------------------------------------------

  [T.EARLY_START_REQUEST]: (v = {}) => {
    const at = text(v.requestedTimeLabel);
    return {
      type: T.EARLY_START_REQUEST,
      title: 'Early start requested',
      body: join(
        `The workshop can start your ${serviceNoun(v.serviceName)} booking`,
        at ? `at ${at}.` : 'earlier than planned.',
        'Tap to accept or decline.'
      ),
      data: bookingData(T.EARLY_START_REQUEST, v, {
        requested_time: v.requestedTime ?? null,
      }),
    };
  },

  [T.EARLY_START_DECLINED]: (v = {}) => ({
    type: T.EARLY_START_DECLINED,
    title: 'Early start declined',
    body: `The customer would prefer to keep the original time for ${serviceName(v.serviceName)}.`,
    data: bookingData(T.EARLY_START_DECLINED, v),
  }),

  [T.EARLY_START_ACCEPTED]: (v = {}) => ({
    type: T.EARLY_START_ACCEPTED,
    title: 'Early start accepted',
    body: `The customer agreed to start ${serviceName(v.serviceName)} early. The job is now in progress.`,
    data: bookingData(T.EARLY_START_ACCEPTED, v),
  }),

  // --- Chat ----------------------------------------------------------------

  [T.NEW_MESSAGE]: (v = {}) => {
    const preview = previewText(v.messageText);
    const sender = text(v.senderName);
    return {
      type: T.NEW_MESSAGE,
      title: sender ? `New message from ${sender}` : 'New message',
      body: preview || 'You have a new message about your booking.',
      data: payload({
        type: T.NEW_MESSAGE,
        conversationId: v.conversationId ?? null,
        bookingId: v.bookingId ?? null,
      }),
    };
  },

  // --- Dispute -------------------------------------------------------------

  [T.SERVICE_DISPUTED]: (v = {}) => ({
    type: T.SERVICE_DISPUTED,
    title: 'Service disputed',
    body: `A customer has raised a dispute for ${serviceName(v.serviceName)}. Our team will review it.`,
    data: bookingData(T.SERVICE_DISPUTED, v),
  }),
};

/**
 * Render one template by type.
 *
 * Throws on an unknown type on purpose -- a typo'd constant should fail in
 * tests rather than quietly send an empty notification in production.
 */
export const renderNotification = (type, vars = {}) => {
  const template = notificationTemplates[type];
  if (typeof template !== 'function') {
    throw new Error(`Unknown notification template type: ${String(type)}`);
  }
  return template(vars || {});
};

export default notificationTemplates;
