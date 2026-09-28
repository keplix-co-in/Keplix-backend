// Audit flow for the Interactions module: chat/conversations, reviews,
// feedback, notifications -- customer and vendor sides. See AUDIT.md.
process.env.AUDIT_DB_NAME = 'keplix_audit_interactions';

const { seed } = await import('./seed.mjs');
const { scanForBrokenShapes } = await import('./assertShape.mjs');
const { prisma, bcrypt, call, token, listRoutes, shutdown } = await import('./harness.mjs');

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
  if (cond) { pass++; results.push(`PASS  ${name}`); }
  else { fail++; results.push(`FAIL  ${name}${extra ? ' -- ' + extra : ''}`); }
}

try {
  const ids = await seed(prisma, bcrypt);
  const { customer, customer2, vendor, vendor2 } = ids;
  const custTok = token(customer.id);
  const cust2Tok = token(customer2.id);
  const vendTok = token(vendor.id);
  const vend2Tok = token(vendor2.id);

  // ---- Set up a completed booking with a conversation for customer/vendor ----
  const service = ids.services[0]; // Oil Change, vendorId = vendor.id
  const booking = await prisma.booking.create({
    data: {
      userId: customer.id,
      serviceId: service.id,
      booking_date: new Date(), booking_time: '10:00',
      status: 'service_completed',
      conversation: { create: {} },
    },
    include: { conversation: true },
  });
  const conversationId = booking.conversation.id;

  // A second, NOT completed, booking for testing the review-gate.
  const pendingBooking = await prisma.booking.create({
    data: {
      userId: customer.id,
      serviceId: service.id,
      booking_date: new Date(), booking_time: '10:00',
      status: 'confirmed',
    },
  });

  // A booking belonging to customer2, with its own conversation, to test
  // cross-customer isolation.
  const otherBooking = await prisma.booking.create({
    data: {
      userId: customer2.id,
      serviceId: service.id,
      booking_date: new Date(), booking_time: '10:00',
      status: 'service_completed',
      conversation: { create: {} },
    },
    include: { conversation: true },
  });
  const otherConversationId = otherBooking.conversation.id;

  // =========================== CHAT / CONVERSATIONS ===========================

  // Customer: get conversation by booking
  {
    const r = await call('GET', `/interactions/api/user/bookings/${booking.id}/conversation`, { as: custTok });
    check('customer getConversationByBooking -> 200', r.status === 200, `status=${r.status} body=${r.text}`);
    check('customer getConversationByBooking shape clean', scanForBrokenShapes(r.json).length === 0);
  }

  // Customer: list own conversations
  {
    const r = await call('GET', '/interactions/api/user/conversations', { as: custTok });
    check('customer getConversations -> 200', r.status === 200, `status=${r.status}`);
    check('customer conversations includes booking conv', r.json?.data?.some(c => c.id === conversationId));
    check('customer conversations shape clean', scanForBrokenShapes(r.json).length === 0);
  }

  // Customer sends a message
  let custMsgId;
  {
    const r = await call('POST', '/interactions/api/user/chat/send', { as: custTok, body: { conversationId, message_text: 'Hello vendor, when will you arrive?' } });
    check('customer sendMessage -> 201', r.status === 201, `status=${r.status} body=${r.text}`);
    check('customer sendMessage shape clean', scanForBrokenShapes(r.json).length === 0);
    custMsgId = r.json?.id;
  }

  // Vendor receives it: get vendor messages for that conversation
  {
    const r = await call('GET', `/interactions/api/vendor/chat/${conversationId}`, { as: vendTok });
    check('vendor getVendorMessages -> 200', r.status === 200, `status=${r.status} body=${r.text}`);
    const list = Array.isArray(r.json) ? r.json : r.json?.data;
    check('vendor sees customer message', Array.isArray(list) && list.some(m => m.id === custMsgId), JSON.stringify(r.json).slice(0, 200));
  }

  // Vendor replies
  let vendMsgId;
  {
    const r = await call('POST', '/interactions/api/vendor/chat/send', { as: vendTok, body: { conversationId, message_text: 'On my way!' } });
    check('vendor sendVendorMessage -> 201', r.status === 201, `status=${r.status} body=${r.text}`);
    vendMsgId = r.json?.id;
  }

  // Customer receives vendor's reply via /interactions/api/user/chat/:conversationId (real route per PROJECT_LOG)
  {
    const r = await call('GET', `/interactions/api/user/chat/${conversationId}`, { as: custTok });
    check('customer getMessages (real route) -> 200', r.status === 200, `status=${r.status} body=${r.text}`);
    const list = r.json?.data;
    check('customer sees vendor reply', Array.isArray(list) && list.some(m => m.id === vendMsgId), JSON.stringify(r.json).slice(0, 200));
    check('customer getMessages shape clean', scanForBrokenShapes(r.json).length === 0);
  }

  // Customer notifications: verify the real notification route works and the
  // vendor's reply produced a notification for the customer.
  {
    const r = await call('GET', `/interactions/api/user/notifications/users/${customer.id}`, { as: custTok });
    check('customer notifications real route -> 200', r.status === 200, `status=${r.status} body=${r.text}`);
    check('customer notifications shape clean', scanForBrokenShapes(r.json).length === 0);
    const hasMsgNotif = r.json?.notifications?.some(n => n.type === 'NEW_MESSAGE' || /message/i.test(n.title || '') || /message/i.test(n.message || ''));
    check('customer got a new-message notification', !!hasMsgNotif, JSON.stringify(r.json?.notifications).slice(0, 300));
  }

  // Customer2 must NOT be able to read customer's conversation (403/404)
  {
    const r = await call('GET', `/interactions/api/user/chat/${conversationId}`, { as: cust2Tok });
    check('customer2 reading customer1 conversation -> 403/404', r.status === 403 || r.status === 404, `status=${r.status}`);
  }
  {
    const r = await call('POST', '/interactions/api/user/chat/send', { as: cust2Tok, body: { conversationId, message_text: 'sneaky' } });
    check('customer2 sending into customer1 conversation -> 403/404', r.status === 403 || r.status === 404, `status=${r.status}`);
  }
  // Cross check the other direction too, using customer2's own conversation id
  {
    const r = await call('GET', `/interactions/api/user/chat/${otherConversationId}`, { as: custTok });
    check('customer1 reading customer2 conversation -> 403/404', r.status === 403 || r.status === 404, `status=${r.status}`);
  }
  // Vendor2 (unrelated vendor) must not read vendor1's conversation
  {
    const r = await call('GET', `/interactions/api/vendor/chat/${conversationId}`, { as: vend2Tok });
    check('vendor2 reading vendor1 conversation -> 403/404', r.status === 403 || r.status === 404, `status=${r.status}`);
  }

  // =========================== REVIEWS ===========================

  // Review create should be REJECTED for the non-completed booking.
  {
    const r = await call('POST', '/interactions/api/reviews/create', { as: custTok, body: { bookingId: pendingBooking.id, rating: 5, comment: 'great' } });
    check('review create on non-completed booking -> 403', r.status === 403, `status=${r.status} body=${r.text}`);
  }

  // Review create succeeds for the completed booking.
  let reviewId;
  {
    const r = await call('POST', '/interactions/api/reviews/create', { as: custTok, body: { bookingId: booking.id, rating: 5, comment: 'Great service!' } });
    check('review create on completed booking -> 201', r.status === 201, `status=${r.status} body=${r.text}`);
    check('review create shape clean', scanForBrokenShapes(r.json).length === 0);
    reviewId = r.json?.data?.id;
  }

  // Duplicate review on the same booking is rejected
  {
    const r = await call('POST', '/interactions/api/reviews/create', { as: custTok, body: { bookingId: booking.id, rating: 4, comment: 'again' } });
    check('duplicate review -> 400', r.status === 400, `status=${r.status}`);
  }

  // Vendor replies to the review
  {
    const r = await call('POST', `/interactions/api/vendor/reviews/${reviewId}/reply`, { as: vendTok, body: { reply: 'Thank you for the kind words!' } });
    check('vendor reply to review -> 200', r.status === 200, `status=${r.status} body=${r.text}`);
    check('vendor reply persisted', r.json?.data?.reply === 'Thank you for the kind words!');
  }

  // Vendor2 cannot reply to vendor1's review
  {
    const r = await call('POST', `/interactions/api/vendor/reviews/${reviewId}/reply`, { as: vend2Tok, body: { reply: 'not mine' } });
    check('vendor2 replying to vendor1 review -> 404', r.status === 404, `status=${r.status}`);
  }

  // Vendor sees its reviews list including the reply
  {
    const r = await call('GET', '/interactions/api/vendor/reviews', { as: vendTok });
    check('vendor getVendorReviews -> 200', r.status === 200, `status=${r.status}`);
    check('vendor reviews shape clean', scanForBrokenShapes(r.json).length === 0);
    check('vendor reviews list includes reply', r.json?.data?.some(rv => rv.id === reviewId && rv.reply));
  }

  // =========================== FEEDBACK ===========================

  {
    const r = await call('POST', '/interactions/api/feedback/create', { as: custTok, body: { title: 'App idea', message: 'Add dark mode', category: 'feature_request' } });
    check('customer feedback create -> 201', r.status === 201, `status=${r.status} body=${r.text}`);
    check('customer feedback shape clean', scanForBrokenShapes(r.json).length === 0);
  }
  {
    const r = await call('GET', '/interactions/api/feedback', { as: custTok });
    check('customer feedback list -> 200', r.status === 200, `status=${r.status}`);
  }
  {
    const r = await call('POST', '/interactions/api/vendor/feedback/create', { as: vendTok, body: { title: 'Feature request', message: 'Please add payouts dashboard', category: 'feature_request' } });
    check('vendor feedback create -> 201', r.status === 201, `status=${r.status} body=${r.text}`);
  }
  {
    const r = await call('GET', '/interactions/api/vendor/feedback', { as: vendTok });
    check('vendor feedback list -> 200', r.status === 200, `status=${r.status}`);
  }

  // =========================== NOTIFICATIONS ===========================

  // Grab a notification id for the customer to mark-read/delete.
  const notifBefore = await call('GET', `/interactions/api/user/notifications/users/${customer.id}`, { as: custTok });
  const notifId = notifBefore.json?.notifications?.[0]?.id;
  check('customer has at least one notification to work with', !!notifId, JSON.stringify(notifBefore.json).slice(0, 300));

  if (notifId) {
    const r = await call('PUT', `/interactions/api/user/notifications/${notifId}/mark-read`, { as: custTok });
    check('customer mark-read -> 200', r.status === 200, `status=${r.status} body=${r.text}`);
    check('customer mark-read persisted', r.json?.is_read === true);
  }

  {
    const r = await call('PUT', `/interactions/api/user/notifications/user/${customer.id}/read-all`, { as: custTok });
    check('customer mark-all-read -> 200', r.status === 200, `status=${r.status}`);
  }

  // Customer2 must not be able to mark-read customer1's notification
  if (notifId) {
    const r = await call('PUT', `/interactions/api/user/notifications/${notifId}/mark-read`, { as: cust2Tok });
    check('customer2 mark-read on customer1 notif -> 404', r.status === 404, `status=${r.status}`);
  }

  if (notifId) {
    const r = await call('DELETE', `/interactions/api/user/notifications/user/${customer.id}/${notifId}`, { as: custTok });
    check('customer delete notification -> 200', r.status === 200, `status=${r.status} body=${r.text}`);
  }

  // Vendor notifications: list + mark-read
  const vendNotifList = await call('GET', '/interactions/api/vendor/notifications', { as: vendTok });
  check('vendor notification list -> 200', vendNotifList.status === 200, `status=${vendNotifList.status}`);
  check('vendor notification shape clean', scanForBrokenShapes(vendNotifList.json).length === 0);
  const vendNotifId = vendNotifList.json?.notifications?.[0]?.id;
  check('vendor has at least one notification (from the message flow)', !!vendNotifId, JSON.stringify(vendNotifList.json).slice(0, 300));

  if (vendNotifId) {
    const r = await call('PUT', `/interactions/api/vendor/notifications/${vendNotifId}/mark-read`, { as: vendTok });
    check('vendor mark-read -> 200', r.status === 200, `status=${r.status} body=${r.text}`);
  }
  // vendor2 cannot mark vendor1's notification
  if (vendNotifId) {
    const r = await call('PUT', `/interactions/api/vendor/notifications/${vendNotifId}/mark-read`, { as: vend2Tok });
    check('vendor2 mark-read on vendor1 notif -> 404', r.status === 404, `status=${r.status}`);
  }

} catch (e) {
  console.error('UNCAUGHT ERROR IN AUDIT SCRIPT:', e);
  fail++;
  results.push(`FAIL  uncaught: ${e.stack}`);
} finally {
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  await shutdown();
  process.exit(fail > 0 ? 1 : 0);
}
