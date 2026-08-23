/**
 * preview_notifications.js
 *
 * Renders every notification template with representative data and prints the
 * title and body, so the whole set of user-facing copy can be read and edited
 * without installing a build on a device.
 *
 *   node scripts/preview_notifications.js
 *   node scripts/preview_notifications.js --empty   # render with no vars at all
 *
 * The --empty pass is the interesting one: it shows the wording every template
 * degrades to when the surrounding row is missing a service name, an amount or
 * a booking id. Nothing there may ever read "undefined".
 */

import {
  notificationTemplates,
  NOTIFICATION_TYPES as T,
} from '../util/notificationTemplates.js';

const SAMPLE = {
  serviceName: 'Full Body Wash & Polish',
  customerName: 'Asha Menon',
  bookingId: 4821,
  paymentId: 991,
  bookingDate: '2026-09-01T09:30:00.000Z',
  amount: 2450,
  status: 'service_completed',
  requestedTime: '10:30',
  requestedTimeLabel: '10:30 AM',
  etaText: 'in 5-7 business days',
  messageText:
    'Hi, can you please also check the brake pads on the front left wheel while the car is up',
  senderName: 'Asha Menon',
  conversationId: 733,
};

const GROUPS = [
  ['Booking lifecycle -- to the customer', [
    T.BOOKING_REQUEST_ACCEPTED,
    T.BOOKING_REQUEST_DECLINED,
    T.BOOKING_CONFIRMED,
    T.BOOKING_STATUS_UPDATED,
    T.SERVICE_STARTED,
    T.SERVICE_COMPLETED,
    T.BOOKING_CANCELLED_BY_VENDOR,
    T.BOOKING_AUTO_DECLINED,
    T.BOOKING_EXPIRED,
  ]],
  ['Booking lifecycle -- to the vendor', [
    T.NEW_BOOKING_ALERT,
    T.BOOKING_CANCELLED_BY_CUSTOMER,
    T.BOOKING_REQUEST_EXPIRED,
    T.SERVICE_TIME_ARRIVED,
    T.BOOKING_MISSED_EXPIRED,
  ]],
  ['Money', [
    T.PAYMENT_RECEIVED,
    T.PAYOUT_SETTLED,
    T.REFUND_ISSUED,
    T.REFUND_UNDER_REVIEW,
  ]],
  ['Early start', [
    T.EARLY_START_REQUEST,
    T.EARLY_START_DECLINED,
    T.EARLY_START_ACCEPTED,
  ]],
  ['Chat and disputes', [
    T.NEW_MESSAGE,
    T.SERVICE_DISPUTED,
  ]],
];

const empty = process.argv.includes('--empty');
const vars = empty ? {} : SAMPLE;

let count = 0;
const problems = [];

console.log('');
console.log(empty
  ? 'NOTIFICATION COPY -- rendered with NO data (fallback wording)'
  : 'NOTIFICATION COPY -- rendered with representative data');
console.log('='.repeat(78));

for (const [groupName, types] of GROUPS) {
  console.log('');
  console.log(`## ${groupName}`);
  console.log('-'.repeat(78));
  for (const type of types) {
    const n = notificationTemplates[type](vars);
    count += 1;
    console.log('');
    console.log(`  [${n.type}]`);
    console.log(`  Title : ${n.title}`);
    console.log(`  Body  : ${n.body}`);
    console.log(`  Data  : ${JSON.stringify(n.data)}`);
    for (const banned of ['undefined', 'null', 'NaN']) {
      if (`${n.title} ${n.body}`.includes(banned)) {
        problems.push(`${type} contains "${banned}"`);
      }
    }
  }
}

// Anything declared but not listed in a group above would silently escape the
// preview, which defeats the point of the script.
const covered = new Set(GROUPS.flatMap(([, types]) => types));
const missing = Object.keys(notificationTemplates).filter((t) => !covered.has(t));

console.log('');
console.log('='.repeat(78));
console.log(`${count} template(s) previewed.`);
if (missing.length) {
  console.log(`WARNING: not previewed (add to a group): ${missing.join(', ')}`);
}
if (problems.length) {
  console.log(`WARNING: placeholder text leaked: ${problems.join(', ')}`);
}
if (missing.length || problems.length) process.exitCode = 1;
