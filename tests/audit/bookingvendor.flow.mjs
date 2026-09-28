// Audit: Booking lifecycle, vendor side — routes/vendor/bookings.js and
// routes/vendor/walkInJobs.js. See tests/audit/AUDIT.md.
process.env.AUDIT_DB_NAME = 'keplix_audit_bookingvendor';

const { seed } = await import('./seed.mjs');
const { scanForBrokenShapes } = await import('./assertShape.mjs');
const { prisma, bcrypt, call, token, listRoutes, shutdown } = await import('./harness.mjs');

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
  if (cond) { pass++; results.push(`PASS  ${name}`); }
  else { fail++; results.push(`FAIL  ${name} ${extra ? '-> ' + JSON.stringify(extra) : ''}`); }
}

const ids = await seed(prisma, bcrypt);
const custTok = token(ids.customer.id);
const cust2Tok = token(ids.customer2.id);
const vendTok = token(ids.vendor.id);
const vend2Tok = token(ids.vendor2.id);

// Helper to create a fresh pending booking as the customer.
async function createBooking(serviceId, dateOffsetDays = 1, time = '10:00') {
  const d = new Date();
  d.setDate(d.getDate() + dateOffsetDays);
  const res = await call('POST', `/service_api/user/${ids.customer.id}/bookings/create`, {
    as: custTok,
    body: {
      serviceId,
      booking_date: d.toISOString(),
      booking_time: time,
      notes: 'audit booking',
    },
  });
  return res;
}

console.log('Routes containing "vendor" and booking/walk-in:');
listRoutes().filter(r => /vendor.*(bookings|walk-in-jobs)/.test(r.path)).forEach(r => console.log(' ', r.method, r.path));

// ---------------------------------------------------------------------------
// 1. Accept a pending request
// ---------------------------------------------------------------------------
{
  const created = await createBooking(ids.services[0].id, 1, '10:00');
  check('create booking (setup) -> 201', created.status === 201, created);
  const bookingId = created.json?.booking?.id ?? created.json?.id;
  check('booking id present', !!bookingId, created.json);

  const res = await call('PATCH', `/service_api/vendor/bookings/${bookingId}/respond`, {
    as: vendTok,
    body: { vendor_status: 'accepted' },
  });
  check('accept pending booking -> 200', res.status === 200, res);
  check('accept response shape clean', scanForBrokenShapes(res.json).length === 0, scanForBrokenShapes(res.json));
  check('vendor_status now accepted', res.json?.vendor_status === 'accepted', res.json);
  check('status now confirmed', res.json?.status === 'confirmed', res.json);

  // ---------------------------------------------------------------------
  // Accept an already-accepted one -> should be safe, not 500
  // ---------------------------------------------------------------------
  const res2 = await call('PATCH', `/service_api/vendor/bookings/${bookingId}/respond`, {
    as: vendTok,
    body: { vendor_status: 'accepted' },
  });
  check('re-accept already-accepted -> 400 (not 500)', res2.status === 400, res2);

  // ---------------------------------------------------------------------
  // Invalid status transition: jump straight to 'completed' from
  // 'confirmed' without ever going in_progress -- controller explicitly
  // allows confirmed -> completed ("quick jobs"), so this should succeed,
  // not be rejected. But jumping to 'completed' from a booking still
  // vendor_status 'pending' (never accepted) should be rejected structurally
  // since such booking never reaches 'confirmed'. Test both:
  // (a) confirmed -> completed (allowed, documented)
  const resComplete = await call('PATCH', `/service_api/vendor/${ids.vendor.id}/bookings/update/${bookingId}`, {
    as: vendTok,
    body: { status: 'completed' },
  });
  check('confirmed -> completed allowed per code comments -> 200', resComplete.status === 200, resComplete);
}

// ---------------------------------------------------------------------------
// 2. Reject a pending booking
// ---------------------------------------------------------------------------
{
  const created = await createBooking(ids.services[1].id, 2, '11:00');
  const bookingId = created.json?.booking?.id ?? created.json?.id;
  check('create booking #2 (setup) -> 201', created.status === 201, created);

  const res = await call('PATCH', `/service_api/vendor/bookings/${bookingId}/respond`, {
    as: vendTok,
    body: { vendor_status: 'rejected' },
  });
  check('reject pending booking -> 200', res.status === 200, res);
  check('vendor_status now rejected', res.json?.vendor_status === 'rejected', res.json);
  check('status now cancelled', res.json?.status === 'cancelled', res.json);
}

// ---------------------------------------------------------------------------
// 3. Invalid status transition: pending -> completed directly (never
//    accepted) should be rejected, not silently allowed.
// ---------------------------------------------------------------------------
{
  const created = await createBooking(ids.services[2].id, 3, '12:00');
  const bookingId = created.json?.booking?.id ?? created.json?.id;
  check('create booking #3 (setup) -> 201', created.status === 201, created);

  const res = await call('PATCH', `/service_api/vendor/${ids.vendor.id}/bookings/update/${bookingId}`, {
    as: vendTok,
    body: { status: 'completed' },
  });
  // currentBooking.status is still 'pending' at this point (never accepted),
  // and allowedFrom for 'completed' is ['in_progress','confirmed','scheduled','service_completed'].
  // pending is NOT in that list, so this should be rejected.
  check('pending -> completed rejected -> 400', res.status === 400, res);
}

// ---------------------------------------------------------------------------
// 4. Vendor trying to respond to another vendor's booking -> 403/404
// ---------------------------------------------------------------------------
{
  const created = await createBooking(ids.services[0].id, 4, '13:00');
  const bookingId = created.json?.booking?.id ?? created.json?.id;
  check('create booking #4 (setup) -> 201', created.status === 201, created);

  const res = await call('PATCH', `/service_api/vendor/bookings/${bookingId}/respond`, {
    as: vend2Tok,
    body: { vendor_status: 'accepted' },
  });
  check('other vendor respond -> 403/404', res.status === 403 || res.status === 404, res);

  const res2 = await call('PATCH', `/service_api/vendor/${ids.vendor.id}/bookings/update/${bookingId}`, {
    as: vend2Tok,
    body: { status: 'completed' },
  });
  check('other vendor update status -> 403/404', res2.status === 403 || res2.status === 404, res2);

  const res3 = await call('POST', `/service_api/vendor/${ids.vendor2.id}/bookings/${bookingId}/early-start`, {
    as: vend2Tok,
    body: {},
  });
  check('other vendor early-start -> 403/404', res3.status === 403 || res3.status === 404, res3);
}

// ---------------------------------------------------------------------------
// 5. Early-start request flow (own booking, confirmed)
// ---------------------------------------------------------------------------
{
  const created = await createBooking(ids.services[0].id, 5, '15:00');
  const bookingId = created.json?.booking?.id ?? created.json?.id;
  await call('PATCH', `/service_api/vendor/bookings/${bookingId}/respond`, {
    as: vendTok, body: { vendor_status: 'accepted' },
  });

  const res = await call('POST', `/service_api/vendor/${ids.vendor.id}/bookings/${bookingId}/early-start`, {
    as: vendTok,
    body: { booking_time: '14:00', note: 'can we start earlier?' },
  });
  check('early-start request on own confirmed booking -> 200', res.status === 200, res);
  check('early-start response shape clean', scanForBrokenShapes(res.json).length === 0, scanForBrokenShapes(res.json));

  // Early-start not changing booking status
  const check2 = await call('PATCH', `/service_api/vendor/${ids.vendor.id}/bookings/update/${bookingId}`, {
    as: vendTok, body: { status: 'in_progress' },
  });
  check('booking still confirmed until customer answers, in_progress transition still allowed from confirmed', check2.status === 200, check2);
}

// ---------------------------------------------------------------------------
// 6. Walk-in job full lifecycle: open -> in_progress -> completed
// ---------------------------------------------------------------------------
{
  const createRes = await call('POST', '/service_api/vendor/walk-in-jobs', {
    as: vendTok,
    body: {
      customer_name: 'Walk In Cust',
      customer_phone: '9876543210',
      vehicle: { registration: 'DL01AB1234', make: 'Honda', model: 'City', year: 2019 },
      services: [{ name: 'Custom Wash', price: 300 }],
      amount_collected: 0,
      payment_mode: 'cash',
    },
  });
  check('create walk-in job -> 201', createRes.status === 201, createRes);
  check('walk-in create response shape clean', scanForBrokenShapes(createRes.json).length === 0, scanForBrokenShapes(createRes.json));
  const jobId = createRes.json?.job?.id;
  check('walk-in job id present', !!jobId, createRes.json);

  const listRes = await call('GET', '/service_api/vendor/walk-in-jobs', { as: vendTok });
  check('list walk-in jobs -> 200', listRes.status === 200, listRes);
  check('created job present in list', (listRes.json?.data || []).some((j) => j.id === jobId), listRes.json);

  const getRes = await call('GET', `/service_api/vendor/walk-in-jobs/${jobId}`, { as: vendTok });
  check('get walk-in job -> 200', getRes.status === 200, getRes);

  const toProgress = await call('PATCH', `/service_api/vendor/walk-in-jobs/${jobId}/status`, {
    as: vendTok, body: { status: 'in_progress' },
  });
  check('walk-in open -> in_progress -> 200', toProgress.status === 200, toProgress);
  check('walk-in status is in_progress', toProgress.json?.job?.status === 'in_progress', toProgress.json);

  const toCompleted = await call('PATCH', `/service_api/vendor/walk-in-jobs/${jobId}/status`, {
    as: vendTok, body: { status: 'completed', amount_collected: 500, payment_mode: 'upi' },
  });
  // If health-sheet gate is active this could be 409; otherwise 200. Accept either
  // but record explicitly which branch happened, and confirm it's not a 500.
  check('walk-in in_progress -> completed not 500', toCompleted.status !== 500, toCompleted);
  if (toCompleted.status === 200) {
    check('walk-in status is completed', toCompleted.json?.job?.status === 'completed', toCompleted.json);
  } else {
    check('walk-in completion blocked by health-sheet gate -> 409', toCompleted.status === 409, toCompleted);
  }

  // -------------------------------------------------------------------
  // Walk-in notify with no Twilio configured -- must degrade gracefully.
  // -------------------------------------------------------------------
  const notifyRes = await call('POST', `/service_api/vendor/walk-in-jobs/${jobId}/notify`, { as: vendTok });
  check('walk-in notify (no Twilio) -> not 500', notifyRes.status !== 500, notifyRes);
  check('walk-in notify (no Twilio) -> 200', notifyRes.status === 200, notifyRes);

  // Another vendor cannot see/act on this walk-in job
  const otherGet = await call('GET', `/service_api/vendor/walk-in-jobs/${jobId}`, { as: vend2Tok });
  check('other vendor cannot get walk-in job -> 404', otherGet.status === 404, otherGet);

  const otherNotify = await call('POST', `/service_api/vendor/walk-in-jobs/${jobId}/notify`, { as: vend2Tok });
  check('other vendor cannot notify walk-in job -> 404', otherNotify.status === 404, otherNotify);
}

// ---------------------------------------------------------------------------
// Print summary
// ---------------------------------------------------------------------------
console.log('\n' + results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);

await shutdown();
process.exit(fail > 0 ? 1 : 0);
