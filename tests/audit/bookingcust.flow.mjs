process.env.AUDIT_DB_NAME = 'keplix_audit_bookingcust';
const { seed } = await import('./seed.mjs');
const { scanForBrokenShapes } = await import('./assertShape.mjs');
const { prisma, bcrypt, call, token, listRoutes, shutdown } = await import('./harness.mjs');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; failures.push({ name, extra }); console.log('FAIL', name, extra ?? ''); }
}
function shapeOk(name, json) {
  const problems = scanForBrokenShapes(json);
  check(name + ' (shape)', problems.length === 0, problems);
}

const ids = await seed(prisma, bcrypt);
const custTok = token(ids.customer.id);
const cust2Tok = token(ids.customer2.id);
const vendorTok = token(ids.vendor.id);
const serviceId = ids.services[0].id;
const vendorUserId = ids.vendor.id;

function tomorrow(offsetDays = 1) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// ---------- 1. Basic create ----------
{
  const date = tomorrow(2);
  const res = await call('POST', `/service_api/user/${ids.customer.id}/bookings/create`, {
    as: custTok,
    body: { serviceId, booking_date: `${date}T00:00:00.000Z`, booking_time: '10:00', notes: 'basic create' },
  });
  check('create basic booking -> 201', res.status === 201, res.json);
  if (res.status === 201) shapeOk('create basic booking', res.json);
  var basicBookingId = res.json?.id;
}

// ---------- 2. List bookings ----------
{
  const res = await call('GET', `/service_api/user/${ids.customer.id}/bookings`, { as: custTok });
  check('list bookings -> 200', res.status === 200, res.json);
  shapeOk('list bookings', res.json);
  check('list bookings includes created', Array.isArray(res.json) && res.json.some(b => b.id === basicBookingId), res.json);
}

// ---------- 3. Single booking ----------
{
  const res = await call('GET', `/service_api/user/${ids.customer.id}/bookings/${basicBookingId}`, { as: custTok });
  check('single booking -> 200', res.status === 200, res.json);
  shapeOk('single booking', res.json);

  // Another customer cannot see it
  const res2 = await call('GET', `/service_api/user/${ids.customer.id}/bookings/${basicBookingId}`, { as: cust2Tok });
  check('single booking not owned -> 404', res2.status === 404, res2.json);
}

// ---------- 4. Concurrent double-booking same vendor+date+time ----------
{
  const date = tomorrow(3);
  const body1 = { serviceId, booking_date: `${date}T00:00:00.000Z`, booking_time: '11:00', notes: 'race A' };
  const body2 = { serviceId, booking_date: `${date}T00:00:00.000Z`, booking_time: '11:00', notes: 'race B' };
  const [r1, r2] = await Promise.all([
    call('POST', `/service_api/user/${ids.customer.id}/bookings/create`, { as: custTok, body: body1 }),
    call('POST', `/service_api/user/${ids.customer2.id}/bookings/create`, { as: cust2Tok, body: body2 }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  check('concurrent double-booking -> one 201 one 409', statuses[0] === 201 && statuses[1] === 409, { r1: r1.status, r2: r2.status, b1: r1.json, b2: r2.json });
}

// ---------- 5. Boundary times: midnight and 23:59 ----------
{
  const date = tomorrow(4);
  const rMidnight = await call('POST', `/service_api/user/${ids.customer.id}/bookings/create`, {
    as: custTok, body: { serviceId, booking_date: `${date}T00:00:00.000Z`, booking_time: '00:00', notes: 'midnight' },
  });
  check('create booking at 00:00 -> 201 (future date, valid boundary time)', rMidnight.status === 201, rMidnight.json);

  const r2359 = await call('POST', `/service_api/user/${ids.customer.id}/bookings/create`, {
    as: custTok, body: { serviceId, booking_date: `${date}T00:00:00.000Z`, booking_time: '23:59', notes: 'late' },
  });
  check('create booking at 23:59 -> 201 (future date, valid boundary time)', r2359.status === 201, r2359.json);
}

// ---------- 6. Booking date in the past ----------
{
  const past = new Date();
  past.setUTCDate(past.getUTCDate() - 5);
  const dateStr = past.toISOString().slice(0, 10);
  const res = await call('POST', `/service_api/user/${ids.customer.id}/bookings/create`, {
    as: custTok, body: { serviceId, booking_date: `${dateStr}T00:00:00.000Z`, booking_time: '10:00', notes: 'past date' },
  });
  check('create booking with past date -> 400 (fixed: createBooking had no past-date guard)', res.status === 400, res.json);
}

// ---------- 7. Reschedule onto another booking's slot ----------
{
  const date = tomorrow(6);
  const rA = await call('POST', `/service_api/user/${ids.customer.id}/bookings/create`, {
    as: custTok, body: { serviceId, booking_date: `${date}T00:00:00.000Z`, booking_time: '09:00', notes: 'slotA' },
  });
  const rB = await call('POST', `/service_api/user/${ids.customer2.id}/bookings/create`, {
    as: cust2Tok, body: { serviceId, booking_date: `${date}T00:00:00.000Z`, booking_time: '13:00', notes: 'slotB' },
  });
  check('setup slotA created', rA.status === 201, rA.json);
  check('setup slotB created', rB.status === 201, rB.json);

  if (rA.status === 201 && rB.status === 201) {
    // Customer2 tries to reschedule their booking (slotB) onto slotA's time -> should 409
    const resReschedule = await call('PUT', `/service_api/user/${ids.customer2.id}/bookings/update/${rB.json.id}`, {
      as: cust2Tok, body: { booking_date: `${date}T00:00:00.000Z`, booking_time: '09:00' },
    });
    check('reschedule onto occupied slot -> 409', resReschedule.status === 409, resReschedule.json);
  }
}

// ---------- 8. Cancel a completed booking should be rejected ----------
let completedBookingId;
{
  const date = tomorrow(7);
  const rCreate = await call('POST', `/service_api/user/${ids.customer.id}/bookings/create`, {
    as: custTok, body: { serviceId, booking_date: `${date}T00:00:00.000Z`, booking_time: '15:00', notes: 'to-complete' },
  });
  check('setup booking for completion flow created', rCreate.status === 201, rCreate.json);
  completedBookingId = rCreate.json?.id;
  if (completedBookingId) {
    await prisma.booking.update({ where: { id: completedBookingId }, data: { status: 'completed' } });
    const resCancel = await call('PUT', `/service_api/user/${ids.customer.id}/bookings/update/${completedBookingId}`, {
      as: custTok, body: { status: 'cancelled' },
    });
    check('cancel already-completed booking -> 400', resCancel.status === 400, resCancel.json);
  }
}

// ---------- 9. Dispute without vendor acceptance ----------
{
  const date = tomorrow(8);
  const rCreate = await call('POST', `/service_api/user/${ids.customer.id}/bookings/create`, {
    as: custTok, body: { serviceId, booking_date: `${date}T00:00:00.000Z`, booking_time: '16:00', notes: 'never-accepted' },
  });
  check('setup never-accepted booking created', rCreate.status === 201, rCreate.json);
  const bId = rCreate.json?.id;
  if (bId) {
    // still status pending, vendor_status pending (no accept ever happened)
    const resDispute = await call('POST', `/service_api/user/${ids.customer.id}/bookings/${bId}/dispute`, {
      as: custTok, body: { reason: 'Vendor never showed up and I want to dispute this booking.' },
    });
    check('dispute without vendor ever marking service_completed -> 400 (fixed: was unconditional)', resDispute.status === 400, resDispute.json);
  }
}

// ---------- 10. Confirm with out-of-range rating (0 or 6) ----------
{
  const date = tomorrow(9);
  const rCreate = await call('POST', `/service_api/user/${ids.customer.id}/bookings/create`, {
    as: custTok, body: { serviceId, booking_date: `${date}T00:00:00.000Z`, booking_time: '17:00', notes: 'confirm-test' },
  });
  const bId = rCreate.json?.id;
  check('setup confirm-test booking created', rCreate.status === 201, rCreate.json);
  if (bId) {
    // Drive to service_completed with a successful payment via direct DB manipulation
    // (payment gateway is out of scope; vendor-side multipart upload flow is another
    // module's territory — we only need the STATE, not to exercise that route).
    await prisma.booking.update({ where: { id: bId }, data: { status: 'service_completed', vendor_status: 'accepted' } });
    await prisma.payment.create({
      data: { booking: { connect: { id: bId } }, amount: '799.00', status: 'success', method: 'card', vendorPayoutStatus: 'pending' },
    });

    const rRating0 = await call('POST', `/service_api/user/${ids.customer.id}/bookings/${bId}/confirm`, {
      as: custTok, body: { confirmed: true, rating: 0 },
    });
    check('confirm with rating=0 -> 400', rRating0.status === 400, rRating0.json);

    const rRating6 = await call('POST', `/service_api/user/${ids.customer.id}/bookings/${bId}/confirm`, {
      as: custTok, body: { confirmed: true, rating: 6 },
    });
    check('confirm with rating=6 -> 400', rRating6.status === 400, rRating6.json);

    // Sanity: a valid rating succeeds
    const rGood = await call('POST', `/service_api/user/${ids.customer.id}/bookings/${bId}/confirm`, {
      as: custTok, body: { confirmed: true, rating: 5, comment: 'great' },
    });
    check('confirm with rating=5 -> 200', rGood.status === 200, rGood.json);
    shapeOk('confirm with rating=5', rGood.json);
  }
}

// ---------- 11. Can-pay ----------
{
  const date = tomorrow(10);
  const rCreate = await call('POST', `/service_api/user/${ids.customer.id}/bookings/create`, {
    as: custTok, body: { serviceId, booking_date: `${date}T00:00:00.000Z`, booking_time: '10:30', notes: 'canpay' },
  });
  const bId = rCreate.json?.id;
  if (bId) {
    const res = await call('GET', `/service_api/user/${ids.customer.id}/bookings/${bId}/can-pay`, { as: custTok });
    check('can-pay -> 200', res.status === 200, res.json);
    shapeOk('can-pay', res.json);
    check('can-pay false before acceptance', res.json?.canPay === false, res.json);

    // Not authorized for another customer
    const res2 = await call('GET', `/service_api/user/${ids.customer.id}/bookings/${bId}/can-pay`, { as: cust2Tok });
    check('can-pay not authorized -> 403', res2.status === 403, res2.json);
  }
}

// ---------- 12. Cancellation preview ----------
{
  const date = tomorrow(11);
  const rCreate = await call('POST', `/service_api/user/${ids.customer.id}/bookings/create`, {
    as: custTok, body: { serviceId, booking_date: `${date}T00:00:00.000Z`, booking_time: '10:45', notes: 'preview' },
  });
  const bId = rCreate.json?.id;
  if (bId) {
    const res = await call('GET', `/service_api/user/${ids.customer.id}/bookings/${bId}/cancellation-preview`, { as: custTok });
    check('cancellation-preview -> 200', res.status === 200, res.json);
    shapeOk('cancellation-preview', res.json);

    const res2 = await call('GET', `/service_api/user/${ids.customer.id}/bookings/${bId}/cancellation-preview`, { as: cust2Tok });
    check('cancellation-preview not authorized -> 403', res2.status === 403, res2.json);
  }
}

// ---------- 13. Normal cancel + refund view shape ----------
{
  const date = tomorrow(12);
  const rCreate = await call('POST', `/service_api/user/${ids.customer.id}/bookings/create`, {
    as: custTok, body: { serviceId, booking_date: `${date}T00:00:00.000Z`, booking_time: '11:15', notes: 'to-cancel' },
  });
  const bId = rCreate.json?.id;
  if (bId) {
    const res = await call('PUT', `/service_api/user/${ids.customer.id}/bookings/update/${bId}`, {
      as: custTok, body: { status: 'cancelled' },
    });
    check('normal cancel -> 200', res.status === 200, res.json);
    shapeOk('normal cancel', res.json);

    // Cancel again -> already cancelled, non-cancellable
    const res2 = await call('PUT', `/service_api/user/${ids.customer.id}/bookings/update/${bId}`, {
      as: custTok, body: { status: 'cancelled' },
    });
    check('cancel already-cancelled -> 400', res2.status === 400, res2.json);
  }
}

// ---------- 14. Advisory-lock regression check: reschedule must not 500 ----------
{
  const date = tomorrow(13);
  const rCreate = await call('POST', `/service_api/user/${ids.customer.id}/bookings/create`, {
    as: custTok, body: { serviceId, booking_date: `${date}T00:00:00.000Z`, booking_time: '12:00', notes: 'lock-check' },
  });
  check('advisory-lock: create does not 500', rCreate.status !== 500, rCreate.json);
  const bId = rCreate.json?.id;
  if (bId) {
    const date2 = tomorrow(14);
    const res = await call('PUT', `/service_api/user/${ids.customer.id}/bookings/update/${bId}`, {
      as: custTok, body: { booking_date: `${date2}T00:00:00.000Z`, booking_time: '12:00' },
    });
    check('advisory-lock: reschedule does not 500', res.status !== 500, res.json);
  }
}

console.log('\n=== ROUTES REGISTERED (user bookings related) ===');
for (const r of listRoutes()) {
  if (/booking/i.test(r.path)) console.log(r.method, r.path);
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (failures.length) {
  console.log(JSON.stringify(failures, null, 2));
}

await shutdown();
process.exit(fail > 0 ? 1 : 0);
