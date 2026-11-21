/**
 * Pricing v2 workshop flow (services/pricingV2Service.js), against a small
 * in-memory stand-in for Prisma so the state machine is exercised end to end:
 * check-in, extra-work requests and per-item decisions, supersede, call
 * requests, the final bill (exclusions, lapsing, waiver, idempotency, number),
 * void + reissue, and the audit/socket/notification side effects.
 *
 * The fake implements only the calls the service makes. $transaction
 * snapshots the state and restores it on a throw, like a real rollback.
 */
import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// In-memory fake
// ---------------------------------------------------------------------------
let db;
let nextId;
const newId = () => ++nextId;

const matches = (row, where = {}) =>
  Object.entries(where).every(([k, cond]) => {
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && 'in' in cond) return cond.in.includes(row[k]);
    if (k === 'service') return row.vendorId === cond.vendorId; // booking.service.vendorId
    return (row[k] ?? null) === cond;
  });

const updateRows = (rows, where, data) => {
  const hit = rows.filter((r) => matches(r, where));
  hit.forEach((r) => Object.assign(r, data));
  return { count: hit.length };
};

const assembleBooking = () => {
  const b = db.booking;
  if (!b) return null;
  return {
    ...b,
    service: { id: 3, name: 'Brake service', vendorId: b.vendorId, vendor: { vendorProfile: { business_name: 'Raj Motors' } } },
    payment: db.payment,
    bookingQuote: db.quote ? { ...db.quote, lines: db.quoteLines.map((l) => ({ ...l })) } : null,
    bookingJob: db.job ? { ...db.job } : null,
    extraWorkRequests: db.requests.map((r) => ({ ...r, items: db.items.filter((i) => i.requestId === r.id).map((i) => ({ ...i })) })),
    finalBills: db.bills
      .filter((x) => ['issued', 'paid'].includes(x.status))
      .map((x) => ({ ...x, lines: db.billLines.filter((l) => l.billId === x.id) })),
  };
};

const fake = {
  $executeRaw: jest.fn(async () => 1),
  $queryRaw: jest.fn(async (_strings, year) => {
    db.counter[year] = (db.counter[year] ?? 0) + 1;
    return [{ last: db.counter[year] }];
  }),
  booking: {
    findUnique: jest.fn(async ({ where }) => (db.booking && db.booking.id === where.id ? assembleBooking() : null)),
    updateMany: jest.fn(async ({ where, data }) => updateRows(db.booking ? [db.booking] : [], where, data)),
  },
  bookingJob: {
    create: jest.fn(async ({ data }) => {
      db.job = { id: newId(), checked_in_at: new Date(), inspection_started_at: null, work_started_at: null, work_completed_at: null, ...data };
      return db.job;
    }),
    updateMany: jest.fn(async ({ where, data }) => updateRows(db.job ? [db.job] : [], where, data)),
  },
  extraWorkRequest: {
    create: jest.fn(async ({ data }) => {
      const { items, ...rest } = data;
      const r = { id: newId(), status: 'pending', call_requested_at: null, createdAt: new Date(), ...rest };
      db.requests.push(r);
      for (const i of items.create) db.items.push({ id: newId(), requestId: r.id, decision: 'pending', decided_at: null, decided_by: null, app_version: null, ...i });
      return r;
    }),
    update: jest.fn(async ({ where, data }) => {
      const r = db.requests.find((x) => x.id === where.id);
      Object.assign(r, data);
      return r;
    }),
  },
  extraWorkItem: {
    updateMany: jest.fn(async ({ where, data }) => updateRows(db.items, where, data)),
  },
  finalBill: {
    create: jest.fn(async ({ data }) => {
      const { lines, ...rest } = data;
      if (db.bills.some((x) => x.open_booking_id != null && x.open_booking_id === rest.open_booking_id)) {
        throw Object.assign(new Error('unique'), { code: 'P2002', meta: { target: ['open_booking_id'] } });
      }
      const bill = { id: newId(), issued_at: new Date(), paid_at: null, ...rest };
      db.bills.push(bill);
      for (const l of lines.create) db.billLines.push({ id: newId(), billId: bill.id, ...l });
      return bill;
    }),
    updateMany: jest.fn(async ({ where, data }) => updateRows(db.bills, where, data)),
  },
  bookingEvent: {
    create: jest.fn(async ({ data }) => {
      db.events.push(data);
      return data;
    }),
  },
  $transaction: jest.fn(async (fn) => {
    const snapshot = structuredClone(db);
    try {
      return await fn(fake);
    } catch (err) {
      db = snapshot;
      throw err;
    }
  }),
};

const emit = jest.fn();
const to = jest.fn(() => ({ emit }));
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: fake }));
jest.unstable_mockModule('../../socket.js', () => ({ getIO: () => ({ to }) }));
const addNotificationJob = jest.fn(async () => ({ id: 1 }));
jest.unstable_mockModule('../../queues/notificationQueue.js', () => ({ addNotificationJob, default: addNotificationJob }));

const svc = await import('../../services/pricingV2Service.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const USER = 11;
const VENDOR = 22;
const BOOKING = 100;
const vendorCtx = { bookingId: BOOKING, actorId: VENDOR };
const userCtx = { bookingId: BOOKING, actorId: USER };

const seed = ({ status = 'confirmed', quote = { pricing_type: 'fixed', inspection_fee: null }, lines } = {}) => {
  nextId = 1000;
  db = {
    booking: { id: BOOKING, userId: USER, vendorId: VENDOR, status, vendor_status: 'accepted' },
    payment: null,
    quote: quote ? { id: 1, bookingId: BOOKING, segment: null, inclusions: [], exclusions: [], tax_inclusive: true, ...quote } : null,
    quoteLines: lines ?? [
      { id: 1, kind: 'labour', name: 'Brake service', qty: 1, unit_price: 3000, sort_order: 0 },
      { id: 2, kind: 'part', name: 'Brake fluid', qty: 2, unit_price: 1000, sort_order: 1 },
    ],
    job: null,
    requests: [],
    items: [],
    bills: [],
    billLines: [],
    events: [],
    counter: {},
  };
};

const checkedIn = async (opts) => {
  seed(opts);
  await svc.checkIn(vendorCtx, { odometer_km: 42000, fuel_level: 'half' });
  jest.clearAllMocks();
};

const expectError = async (promise, status, code) => {
  await expect(promise).rejects.toMatchObject({ status, code });
};

const labour = (name, unit_price) => ({ kind: 'labour', name, qty: 1, unit_price });
const part = (name, unit_price) => ({ kind: 'part', name, qty: 1, unit_price });

beforeEach(() => {
  jest.clearAllMocks();
  seed();
});

// ---------------------------------------------------------------------------
describe('getPricing', () => {
  test('owner sees the v2 view; a legacy booking returns { flow: legacy }', async () => {
    expect((await svc.getPricing({ ...vendorCtx, role: 'vendor' })).flow).toBe('v2');
    db.quote = null;
    expect(await svc.getPricing({ ...userCtx, role: 'user' })).toEqual({ flow: 'legacy' });
  });

  test('someone else -> 403 FORBIDDEN; unknown booking -> 404', async () => {
    await expectError(svc.getPricing({ bookingId: BOOKING, actorId: 999, role: 'user' }), 403, 'FORBIDDEN');
    await expectError(svc.getPricing({ bookingId: BOOKING, actorId: USER, role: 'vendor' }), 403, 'FORBIDDEN');
    await expectError(svc.getPricing({ bookingId: 5, actorId: USER, role: 'user' }), 404, 'NOT_FOUND');
  });
});

describe('check-in and job progress', () => {
  test('confirmed -> in_progress, job recorded, audited, both parties pinged, customer notified', async () => {
    const { status, body } = await svc.checkIn(vendorCtx, { odometer_km: 42000, fuel_level: 'half', condition_note: 'Scratch on bumper' });
    expect(status).toBe(200);
    expect(db.booking.status).toBe('in_progress');
    expect(body.job).toMatchObject({ odometer_km: 42000, fuel_level: 'half', condition_note: 'Scratch on bumper' });
    expect(db.events).toEqual([expect.objectContaining({ bookingId: BOOKING, actor_role: 'vendor', actor_id: VENDOR, type: 'job_checked_in' })]);
    expect(to).toHaveBeenCalledWith(`user_${USER}`);
    expect(to).toHaveBeenCalledWith(`user_${VENDOR}`);
    expect(emit).toHaveBeenCalledWith('booking:pricing_updated', { bookingId: BOOKING });
    expect(addNotificationJob).toHaveBeenCalledWith(expect.objectContaining({ recipientId: USER, type: 'job_checked_in' }));
  });

  test('a booking already in_progress (old status endpoint) can still be checked in, once', async () => {
    seed({ status: 'in_progress' });
    await svc.checkIn(vendorCtx, {});
    expect(db.job).not.toBeNull();
    await expectError(svc.checkIn(vendorCtx, {}), 409, 'ALREADY_CHECKED_IN');
  });

  test('pending / cancelled bookings and legacy bookings cannot be checked in', async () => {
    seed({ status: 'pending' });
    db.booking.vendor_status = 'pending';
    await expectError(svc.checkIn(vendorCtx, {}), 409, 'INVALID_STATE');
    seed({ quote: null });
    await expectError(svc.checkIn(vendorCtx, {}), 409, 'NOT_V2');
    expect(db.events).toHaveLength(0);
  });

  test('actions before check-in -> NOT_CHECKED_IN', async () => {
    await expectError(svc.startWork(vendorCtx), 409, 'NOT_CHECKED_IN');
    await expectError(svc.requestExtraWork(vendorCtx, { reason: 'Pads worn', items: [labour('Fix', 100)] }), 409, 'NOT_CHECKED_IN');
    await expectError(svc.issueFinalBill(vendorCtx), 409, 'NOT_CHECKED_IN');
  });

  test('work/complete needs work started; repeat taps are one audited event', async () => {
    await checkedIn();
    await expectError(svc.completeWork(vendorCtx), 409, 'WORK_NOT_STARTED');
    await svc.startWork(vendorCtx);
    await svc.startWork(vendorCtx);
    await svc.completeWork(vendorCtx);
    expect(db.events.map((e) => e.type)).toEqual(['job_checked_in', 'work_started', 'work_completed']);
    expect(db.booking.status).toBe('in_progress'); // completion is still the old status endpoint
  });
});

describe('extra-work state machine', () => {
  const sendRequest = (items, extra = {}) => svc.requestExtraWork(vendorCtx, { reason: 'Found during inspection', items, ...extra });

  test('a request is created with numbered, computed lines and the customer is notified', async () => {
    await checkedIn();
    const { status, body } = await sendRequest([part('Brake pads', 2200), { kind: 'labour', name: 'Fitting', qty: 1.5, unit_price: 400 }]);
    expect(status).toBe(201);
    expect(body.request_id).toBeDefined();
    expect(body.requests[0]).toMatchObject({ number: 1, status: 'pending', pending_total: 2800, approved_total: 0 });
    expect(addNotificationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: USER,
        type: 'extra_work_requested',
        metadata: expect.objectContaining({ data: { type: 'extra_work_requested', bookingId: BOOKING, requestId: body.request_id } }),
      })
    );
  });

  test('partial approve: one approved, one pending; decided_by/app_version recorded; vendor told the counts', async () => {
    await checkedIn();
    await sendRequest([part('Pads', 2200), labour('Disc skim', 600)]);
    const [pads, skim] = db.items;
    const { body } = await svc.decideExtraWork(userCtx, db.requests[0].id, { approve: [pads.id], reject: [] }, '1.1.2');
    expect(db.requests[0].status).toBe('partially_approved');
    expect(db.items.find((i) => i.id === pads.id)).toMatchObject({ decision: 'approved', decided_by: USER, app_version: '1.1.2' });
    expect(db.items.find((i) => i.id === skim.id).decision).toBe('pending');
    expect(body.running_total).toBe(5000 + 2200);
    expect(addNotificationJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ recipientId: VENDOR, type: 'extra_work_decided', body: expect.stringContaining('1 approved, 0 rejected') })
    );
    expect(db.events.at(-1)).toMatchObject({ actor_role: 'user', actor_id: USER, type: 'extra_work_decided' });
  });

  test('reject all -> rejected; nothing added to the running total', async () => {
    await checkedIn();
    await sendRequest([part('Pads', 2200), labour('Skim', 600)]);
    const { body } = await svc.decideExtraWork(userCtx, db.requests[0].id, { approve: [], reject: db.items.map((i) => i.id) });
    expect(db.requests[0].status).toBe('rejected');
    expect(body.running_total).toBe(5000);
  });

  test('all approved -> approved', async () => {
    await checkedIn();
    await sendRequest([part('Pads', 2200)]);
    await svc.decideExtraWork(userCtx, db.requests[0].id, { approve: [db.items[0].id], reject: [] });
    expect(db.requests[0].status).toBe('approved');
  });

  test('a second decision on the same item -> 409 ITEM_NOT_PENDING and nothing changes', async () => {
    await checkedIn();
    await sendRequest([part('Pads', 2200), labour('Skim', 600)]);
    const [pads, skim] = db.items;
    await svc.decideExtraWork(userCtx, db.requests[0].id, { approve: [pads.id], reject: [] });
    const before = structuredClone(db.items);
    await expectError(svc.decideExtraWork(userCtx, db.requests[0].id, { approve: [skim.id], reject: [pads.id] }), 409, 'ITEM_NOT_PENDING');
    expect(db.items).toEqual(before);
  });

  test('an id in both lists -> 400; an id from another request -> 409', async () => {
    await checkedIn();
    await sendRequest([part('Pads', 2200)]);
    const id = db.items[0].id;
    await expectError(svc.decideExtraWork(userCtx, db.requests[0].id, { approve: [id], reject: [id] }), 400, 'VALIDATION_ERROR');
    await expectError(svc.decideExtraWork(userCtx, db.requests[0].id, { approve: [99999], reject: [] }), 409, 'ITEM_NOT_PENDING');
  });

  test('wrong customer -> 403; the vendor cannot approve (403 here, and no vendor route exists)', async () => {
    await checkedIn();
    await sendRequest([part('Pads', 2200)]);
    const rid = db.requests[0].id;
    await expectError(svc.decideExtraWork({ bookingId: BOOKING, actorId: 999 }, rid, { approve: [db.items[0].id] }), 403, 'FORBIDDEN');
    await expectError(svc.decideExtraWork({ bookingId: BOOKING, actorId: VENDOR }, rid, { approve: [db.items[0].id] }), 403, 'FORBIDDEN');
    expect(db.items[0].decision).toBe('pending');

    const vendorRoutes = readFileSync(new URL('../../routes/vendor/bookings.js', import.meta.url), 'utf8');
    expect(vendorRoutes).not.toMatch(/decision/);
  });

  test('supersede: pending items become superseded, approved items stay approved', async () => {
    await checkedIn();
    await sendRequest([part('Pads', 2200), labour('Skim', 600)]);
    const first = db.requests[0];
    const [pads, skim] = db.items;
    await svc.decideExtraWork(userCtx, first.id, { approve: [pads.id], reject: [] });

    const { body } = await sendRequest([labour('Skim (revised)', 450)], { supersedes_id: first.id });
    expect(db.requests.find((r) => r.id === first.id).status).toBe('superseded');
    expect(db.items.find((i) => i.id === pads.id).decision).toBe('approved');
    expect(db.items.find((i) => i.id === skim.id).decision).toBe('superseded');
    expect(body.requests.map((r) => r.number)).toEqual(expect.arrayContaining([1, 2]));
    expect(body.running_total).toBe(5000 + 2200);

    // The replaced request can no longer be decided.
    await expectError(svc.decideExtraWork(userCtx, first.id, { approve: [skim.id] }), 409, 'REQUEST_CLOSED');
  });

  test('only a pending / partly answered request can be superseded', async () => {
    await checkedIn();
    await sendRequest([part('Pads', 2200)]);
    await svc.decideExtraWork(userCtx, db.requests[0].id, { approve: [db.items[0].id] });
    await expectError(sendRequest([labour('x', 1)], { supersedes_id: db.requests[0].id }), 409, 'REQUEST_CLOSED');
  });

  test('call-request only records a timestamp: nothing is approved', async () => {
    await checkedIn();
    await sendRequest([part('Pads', 2200)]);
    await svc.requestCall(userCtx, db.requests[0].id);
    expect(db.requests[0].call_requested_at).toBeInstanceOf(Date);
    expect(db.requests[0].status).toBe('pending');
    expect(db.items[0].decision).toBe('pending');
    expect(addNotificationJob).toHaveBeenLastCalledWith(expect.objectContaining({ recipientId: VENDOR, type: 'extra_work_call_requested' }));
  });

  test('removal: amount copied from the quote line (negative); the same line cannot be removed twice', async () => {
    await checkedIn();
    await sendRequest([{ kind: 'removal', quote_line_id: 2, qty: 99, unit_price: 1 }]);
    expect(db.items[0]).toMatchObject({ kind: 'removal', qty: 2, unit_price: -1000, line_total: -2000, quote_line_id: 2, name: 'Remove: Brake fluid' });
    await expectError(sendRequest([{ kind: 'removal', quote_line_id: 2 }]), 409, 'INVALID_QUOTE_LINE');
    await expectError(sendRequest([{ kind: 'removal', quote_line_id: 777 }]), 409, 'INVALID_QUOTE_LINE');
  });

  test('requestStatusFor', () => {
    const s = (...d) => svc.requestStatusFor(d.map((decision) => ({ decision })));
    expect(s('pending', 'pending')).toBe('pending');
    expect(s('approved', 'pending')).toBe('partially_approved');
    expect(s('approved', 'approved')).toBe('approved');
    expect(s('rejected', 'rejected')).toBe('rejected');
    expect(s('approved', 'rejected')).toBe('partially_approved');
  });
});

describe('final bill', () => {
  const year = new Date(Date.now() + 330 * 60 * 1000).getUTCFullYear();

  test('includes quote + approved only; pending items lapse and are reported; numbered; customer notified', async () => {
    await checkedIn();
    await svc.requestExtraWork(vendorCtx, { reason: 'Found', items: [part('Pads', 2800), labour('Skim', 600), labour('Wash', 300)] });
    const [pads, skim, wash] = db.items;
    await svc.decideExtraWork(userCtx, db.requests[0].id, { approve: [pads.id], reject: [skim.id] });

    const { status, body } = await svc.issueFinalBill(vendorCtx);
    expect(status).toBe(201);
    expect(body.lapsed_item_ids).toEqual([wash.id]);
    expect(db.items.find((i) => i.id === wash.id).decision).toBe('lapsed');
    expect(body.bill).toMatchObject({ number: `KPX-${year}-000001`, status: 'issued', total: 7800, labour_total: 3000, parts_total: 4800 });
    expect(body.bill.lines.map((l) => l.name)).toEqual(['Brake service', 'Brake fluid', 'Pads']);
    expect(db.bills[0].open_booking_id).toBe(BOOKING);
    expect(addNotificationJob).toHaveBeenLastCalledWith(
      expect.objectContaining({
        recipientId: USER,
        type: 'final_bill_issued',
        metadata: expect.objectContaining({
          data: { type: 'final_bill_issued', bookingId: BOOKING, billId: db.bills[0].id, requestId: db.requests[0].id },
        }),
      })
    );
    expect(db.events.at(-1)).toMatchObject({ type: 'final_bill_issued' });
  });

  test('idempotent: a second call returns the same bill with 200, no new number or event', async () => {
    await checkedIn();
    await svc.issueFinalBill(vendorCtx);
    const events = db.events.length;
    const { status, body } = await svc.issueFinalBill(vendorCtx);
    expect(status).toBe(200);
    expect(body.lapsed_item_ids).toEqual([]);
    expect(db.bills).toHaveLength(1);
    expect(db.events).toHaveLength(events);
    expect(fake.$queryRaw).toHaveBeenCalledTimes(1);
  });

  test('inspection quote: approved repairs >= fee add the waiver line', async () => {
    await checkedIn({
      quote: { pricing_type: 'inspection', inspection_fee: 299 },
      lines: [{ id: 1, kind: 'labour', name: 'Inspection fee', qty: 1, unit_price: 299, sort_order: 0 }],
    });
    await svc.requestExtraWork(vendorCtx, { reason: 'Found', items: [labour('Repair', 500)] });
    await svc.decideExtraWork(userCtx, db.requests[0].id, { approve: [db.items[0].id] });
    const { body } = await svc.issueFinalBill(vendorCtx);
    expect(body.bill.lines.at(-1)).toMatchObject({ name: 'Inspection fee waived', line_total: -299, source: 'waiver' });
    expect(body.bill.total).toBe(500);
  });

  // Owner decisions 2026-11-21: free inspection + ₹0 bill auto-close.
  test('free inspection with no extras: ₹0 bill is created paid, final_bill_no_charge, no-charge notice, cannot pay or void', async () => {
    await checkedIn({ quote: { pricing_type: 'inspection', inspection_fee: 0 }, lines: [] });
    expect((await svc.getPricing({ ...userCtx, role: 'user' })).can.pay).toBe(false);
    const { status, body } = await svc.issueFinalBill(vendorCtx);
    expect(status).toBe(201);
    expect(body.bill).toMatchObject({ status: 'paid', total: 0 });
    expect(body.bill.lines).toEqual([]);
    expect(db.bills[0].paid_at).toBeInstanceOf(Date);
    expect(db.payment).toBeNull();
    expect(db.events.at(-1)).toMatchObject({ type: 'final_bill_no_charge' });
    expect(addNotificationJob).toHaveBeenLastCalledWith(expect.objectContaining({ recipientId: USER, type: 'final_bill_no_charge' }));
    expect(body.can.void_bill).toBe(false);
    expect((await svc.getPricing({ ...userCtx, role: 'user' })).can.pay).toBe(false);
    await expectError(svc.voidFinalBill(vendorCtx, { reason: 'Wrong price' }), 409, 'BILL_PAID');
  });

  test('a bill between ₹0 and ₹1 is refused with 422 BILL_TOO_SMALL and nothing is written', async () => {
    await checkedIn({ quote: { pricing_type: 'fixed', inspection_fee: null }, lines: [{ id: 1, kind: 'labour', name: 'Tiny', qty: 1, unit_price: 0.5, sort_order: 0 }] });
    await expectError(svc.issueFinalBill(vendorCtx), 422, 'BILL_TOO_SMALL');
    expect(db.bills).toHaveLength(0);
    expect(db.events.map((e) => e.type)).toEqual(['job_checked_in']);
  });

  test('after the bill: no more extra work or decisions (BILL_EXISTS)', async () => {
    await checkedIn();
    await svc.requestExtraWork(vendorCtx, { reason: 'Found', items: [part('Pads', 2800)] });
    await svc.issueFinalBill(vendorCtx);
    await expectError(svc.requestExtraWork(vendorCtx, { reason: 'More', items: [part('x', 1)] }), 409, 'BILL_EXISTS');
    await expectError(svc.startWork(vendorCtx), 409, 'BILL_EXISTS');
  });

  test('void + reissue: the void frees the slot and the new bill gets the next number', async () => {
    await checkedIn();
    await svc.issueFinalBill(vendorCtx);
    const { body } = await svc.voidFinalBill(vendorCtx, { reason: 'Wrong part price' });
    expect(body.bill).toBeNull();
    expect(db.bills[0]).toMatchObject({ status: 'void', open_booking_id: null, voided_by: VENDOR, void_reason: 'Wrong part price' });
    expect(addNotificationJob).toHaveBeenLastCalledWith(expect.objectContaining({ recipientId: USER, type: 'final_bill_voided' }));

    // Extra work is allowed again before reissuing.
    await svc.requestExtraWork(vendorCtx, { reason: 'Corrected', items: [part('Pads', 2800)] });
    await svc.decideExtraWork(userCtx, db.requests[0].id, { approve: [db.items[0].id] });
    const reissued = await svc.issueFinalBill(vendorCtx);
    expect(reissued.status).toBe(201);
    expect(reissued.body.bill).toMatchObject({ number: `KPX-${year}-000002`, total: 7800 });
  });

  test('a paid bill (or a captured payment) cannot be voided; no bill -> BILL_NOT_ISSUED', async () => {
    await checkedIn();
    await expectError(svc.voidFinalBill(vendorCtx, { reason: 'x x x' }), 409, 'BILL_NOT_ISSUED');
    await svc.issueFinalBill(vendorCtx);
    db.payment = { id: 1, status: 'success' };
    await expectError(svc.voidFinalBill(vendorCtx, { reason: 'too late' }), 409, 'BILL_PAID');
    db.payment = null;
    db.bills[0].status = 'paid';
    await expectError(svc.voidFinalBill(vendorCtx, { reason: 'too late' }), 409, 'BILL_PAID');
    expect(db.bills[0].status).toBe('paid');
  });

  test('the customer can pay only once the bill is issued', async () => {
    await checkedIn();
    expect((await svc.getPricing({ ...userCtx, role: 'user' })).can.pay).toBe(false);
    await svc.issueFinalBill(vendorCtx);
    expect((await svc.getPricing({ ...userCtx, role: 'user' })).can.pay).toBe(true);
  });
});

describe('sendPricingError', () => {
  const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });

  test('maps PricingError, the open-bill unique index, and unknown errors', () => {
    const a = res();
    svc.sendPricingError(a, new svc.PricingError(409, 'BILL_EXISTS', 'x'), 't');
    expect(a.status).toHaveBeenCalledWith(409);
    expect(a.json).toHaveBeenCalledWith({ success: false, message: 'x', code: 'BILL_EXISTS' });

    const b = res();
    svc.sendPricingError(b, { code: 'P2002', meta: { target: ['open_booking_id'] } }, 't');
    expect(b.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'BILL_EXISTS' }));

    const c = res();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    svc.sendPricingError(c, new Error('boom'), 't');
    expect(c.status).toHaveBeenCalledWith(500);
    spy.mockRestore();
  });
});
