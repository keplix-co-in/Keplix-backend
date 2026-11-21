/**
 * Pricing v2 workshop flow (docs/PRICING_V2_API.md sections 3-5, 7, 8):
 * check-in, inspection/work progress, extra-work requests and the customer's
 * per-item decisions, and the final bill.
 *
 * Every action:
 *  1. runs in one transaction, serialised per booking with an advisory lock
 *     (two taps on "Issue bill", or a customer decision racing a supersede,
 *     must never interleave);
 *  2. reloads the booking INSIDE that transaction and validates against it;
 *  3. writes a BookingEvent audit row;
 *  4. after commit, emits `booking:pricing_updated {bookingId}` to both
 *     parties and queues the in-app/push notification (best-effort: a socket
 *     or queue outage must not fail an action that already committed).
 *
 * Shape helpers (the pricing object, `can` flags) live in util/pricingV2.js
 * and the money arithmetic in util/billMath.js.
 */
import prisma from '../util/prisma.js';
import { getIO } from '../socket.js';
import { addNotificationJob } from '../queues/notificationQueue.js';
import { renderNotification, NOTIFICATION_TYPES } from '../util/notificationTemplates.js';
import { buildBillLines, fromPaise, lineTotalPaise, toPaise } from '../util/billMath.js';
import {
  approvedItemsOf,
  buildPricingView,
  CHECK_IN_EXTRA_STATUSES,
  CHECK_IN_FROM_STATUSES,
  openBillOf,
  PARTS_USED_EVENT,
  V2_ACTIVE_STATUSES,
} from '../util/pricingV2.js';
import { BillLinkUnavailableError, signBillToken } from '../util/billToken.js';

export const PRICING_UPDATED_EVENT = 'booking:pricing_updated';

export class PricingError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Everything buildPricingView and the actions need, in one load. */
export const PRICING_BOOKING_INCLUDE = {
  service: {
    select: {
      id: true,
      name: true,
      vendorId: true,
      vendor: { select: { vendorProfile: { select: { business_name: true } } } },
    },
  },
  payment: { select: { id: true, status: true } },
  bookingQuote: { include: { lines: true } },
  bookingJob: true,
  extraWorkRequests: { include: { items: true } },
  // Only the open bill matters to every rule here; voided bills are history.
  finalBills: { where: { status: { in: ['issued', 'paid'] } }, include: { lines: true } },
  // Job photos (G03/G04) and "parts used" notes (G06): side tables, no Booking columns.
  bookingPhotos: true,
  bookingEvents: { where: { type: PARTS_USED_EVENT }, orderBy: { created_at: 'asc' }, take: 50 },
};

// Bounds so one booking cannot accumulate unlimited Cloudinary uploads / notes.
export const MAX_CHECK_IN_PHOTOS = 10;
export const MAX_REQUEST_PHOTOS = 10;
export const MAX_PARTS_USED_NOTES = 20;

const ROLE_VENDOR = 'vendor';
const ROLE_USER = 'user';

const garageNameOf = (booking) => booking.service?.vendor?.vendorProfile?.business_name ?? null;

/**
 * Load a booking and check the caller owns it: 404 when it does not exist,
 * 403 FORBIDDEN when it belongs to someone else.
 */
const loadOwned = async (db, bookingId, role, actorId) => {
  const booking = await db.booking.findUnique({ where: { id: bookingId }, include: PRICING_BOOKING_INCLUDE });
  if (!booking) throw new PricingError(404, 'NOT_FOUND', 'Booking not found');
  const owns = role === ROLE_VENDOR ? booking.service?.vendorId === actorId : booking.userId === actorId;
  if (!owns) throw new PricingError(403, 'FORBIDDEN', 'This booking is not yours');
  return booking;
};

/** GET .../bookings/:id/pricing. A legacy booking returns { flow: 'legacy' }. */
export const getPricing = async ({ bookingId, role, actorId }) => {
  const booking = await loadOwned(prisma, bookingId, role, actorId);
  return buildPricingView(booking, role);
};

const emitPricingUpdated = (booking, extraEvents = []) => {
  try {
    const io = getIO();
    const rooms = [`user_${booking.userId}`, `user_${booking.service?.vendorId}`];
    for (const room of rooms) {
      io.to(room).emit(PRICING_UPDATED_EVENT, { bookingId: booking.id });
      for (const e of extraEvents) io.to(room).emit(e.event, e.data);
    }
  } catch (err) {
    // Sockets not initialised (tests, a worker process) or a transport error:
    // clients still see the change on their next /pricing fetch.
    console.warn(`[pricingV2] socket emit skipped for booking ${booking.id}: ${err.message}`);
  }
};

const queueNotification = async (booking, { type, to, vars = {} }) => {
  try {
    const n = renderNotification(type, { bookingId: booking.id, garageName: garageNameOf(booking), ...vars });
    await addNotificationJob({
      type: n.type,
      recipientId: to === ROLE_VENDOR ? booking.service.vendorId : booking.userId,
      title: n.title,
      body: n.body,
      metadata: { type: n.type, data: n.data, bookingId: booking.id },
    });
  } catch (err) {
    console.error(`[pricingV2] failed to queue ${type} for booking ${booking.id}:`, err?.message);
  }
};

/**
 * Run one v2 action. `fn(tx, booking)` validates and writes, and returns
 * { event?: {type, payload}, notify?: [{type,to,vars}], extra?: object,
 *   status?: number, sockets?: [{event,data}] }. No event = no-op (idempotent
 * repeat): nothing is audited or notified.
 */
const runAction = async ({ bookingId, role, actorId }, fn) => {
  const { out, fresh } = await prisma.$transaction(async (tx) => {
    // $executeRaw, NOT $queryRaw: pg_advisory_xact_lock returns void (same
    // as the booking-slot lock in controllers/user/bookingController.js).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pricing-v2:${bookingId}`}))`;
    const booking = await loadOwned(tx, bookingId, role, actorId);
    if (!booking.bookingQuote) {
      throw new PricingError(409, 'NOT_V2', 'This booking uses the old pricing flow');
    }
    const result = (await fn(tx, booking)) ?? {};
    if (result.event) {
      await tx.bookingEvent.create({
        data: {
          bookingId,
          actor_role: role,
          actor_id: actorId,
          type: result.event.type,
          payload: result.event.payload ?? {},
        },
      });
    }
    const reloaded = await tx.booking.findUnique({ where: { id: bookingId }, include: PRICING_BOOKING_INCLUDE });
    return { out: result, fresh: reloaded };
  });

  if (out.event) {
    emitPricingUpdated(fresh, out.sockets ?? []);
    for (const n of out.notify ?? []) await queueNotification(fresh, n);
  }

  return { status: out.status ?? 200, body: { ...buildPricingView(fresh, role), ...(out.extra ?? {}) } };
};

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

const requireCheckedIn = (booking) => {
  if (!booking.bookingJob) throw new PricingError(409, 'NOT_CHECKED_IN', 'Check the car in first');
};

const requireActive = (booking) => {
  if (booking.vendor_status !== 'accepted' || !V2_ACTIVE_STATUSES.includes(booking.status)) {
    throw new PricingError(409, 'INVALID_STATE', `This booking is ${booking.status}; the workshop flow is not open`);
  }
};

const requireNoOpenBill = (booking) => {
  if (openBillOf(booking.finalBills)) {
    throw new PricingError(409, 'BILL_EXISTS', 'A final bill has already been issued for this booking');
  }
};

// ---------------------------------------------------------------------------
// Vendor actions (section 4)
// ---------------------------------------------------------------------------

export const checkIn = (ctx, body = {}) =>
  runAction({ ...ctx, role: ROLE_VENDOR }, async (tx, booking) => {
    if (booking.bookingJob) {
      throw new PricingError(409, 'ALREADY_CHECKED_IN', 'This car is already checked in');
    }
    const canStart =
      booking.vendor_status === 'accepted' &&
      (CHECK_IN_FROM_STATUSES.includes(booking.status) || CHECK_IN_EXTRA_STATUSES.includes(booking.status));
    if (!canStart) {
      throw new PricingError(409, 'INVALID_STATE', `Cannot check in a booking that is ${booking.status}`);
    }

    if (CHECK_IN_FROM_STATUSES.includes(booking.status)) {
      // Guarded transition, the same pattern as updateBookingStatus: the
      // precondition is repeated in the WHERE so a cancellation committing
      // concurrently can never be overwritten with in_progress.
      const { count } = await tx.booking.updateMany({
        where: {
          id: booking.id,
          service: { vendorId: ctx.actorId },
          vendor_status: 'accepted',
          status: { in: CHECK_IN_FROM_STATUSES },
        },
        data: { status: 'in_progress' },
      });
      if (count === 0) throw new PricingError(409, 'INVALID_STATE', 'The booking changed before check-in could be saved');
    }

    await tx.bookingJob.create({
      data: {
        bookingId: booking.id,
        checked_in_by: ctx.actorId,
        odometer_km: body.odometer_km ?? null,
        fuel_level: body.fuel_level ?? null,
        condition_note: body.condition_note ?? null,
      },
    });

    return {
      event: { type: 'job_checked_in', payload: { odometer_km: body.odometer_km ?? null, fuel_level: body.fuel_level ?? null, from_status: booking.status } },
      notify: [{ type: NOTIFICATION_TYPES.JOB_CHECKED_IN, to: ROLE_USER }],
      // Booking lists refresh on this existing event; the status changed.
      sockets: [{ event: 'booking_updated', data: { bookingId: booking.id, status: 'in_progress' } }],
    };
  });

const jobTimestampAction = (field, eventType, { needs, notifyType } = {}) => (ctx) =>
  runAction({ ...ctx, role: ROLE_VENDOR }, async (tx, booking) => {
    requireCheckedIn(booking);
    requireActive(booking);
    if (needs && !booking.bookingJob[needs]) {
      throw new PricingError(409, 'WORK_NOT_STARTED', 'Start the work first');
    }
    // Repeat taps are a no-op (no second audit row or notification).
    if (booking.bookingJob[field]) return {};
    // Mirrors can.start_inspection: inspecting after the work is done is meaningless.
    if (field === 'inspection_started_at' && booking.bookingJob.work_completed_at) {
      throw new PricingError(409, 'INVALID_STATE', 'The work is already complete');
    }
    if (field !== 'work_completed_at') requireNoOpenBill(booking);

    const { count } = await tx.bookingJob.updateMany({
      where: { bookingId: booking.id, [field]: null },
      data: { [field]: new Date() },
    });
    if (count === 0) return {};
    return {
      event: { type: eventType, payload: {} },
      notify: notifyType ? [{ type: notifyType, to: ROLE_USER }] : [],
    };
  });

export const startInspection = jobTimestampAction('inspection_started_at', 'inspection_started');
export const startWork = jobTimestampAction('work_started_at', 'work_started');
export const completeWork = jobTimestampAction('work_completed_at', 'work_completed', {
  needs: 'work_started_at',
  notifyType: NOTIFICATION_TYPES.WORK_COMPLETED,
});

const num = (v) => (v === null || v === undefined ? null : Number(v.toString()));

/**
 * Attach already-uploaded photos (Cloudinary URLs from middleware/uploadMiddleware.js)
 * to the check-in (kind 'check_in') or to an extra-work request (kind
 * 'extra_work', needs requestId). Photos are append-only evidence: there is
 * no edit or delete.
 */
export const addPhotos = (ctx, { kind, requestId = null, urls }) =>
  runAction({ ...ctx, role: ROLE_VENDOR }, async (tx, booking) => {
    requireCheckedIn(booking);
    requireActive(booking);
    const existing = booking.bookingPhotos ?? [];

    if (kind === 'check_in') {
      if (existing.filter((p) => p.kind === 'check_in').length + urls.length > MAX_CHECK_IN_PHOTOS) {
        throw new PricingError(409, 'PHOTO_LIMIT', `At most ${MAX_CHECK_IN_PHOTOS} check-in photos per booking`);
      }
    } else {
      requireNoOpenBill(booking);
      const request = findRequest(booking, requestId);
      // Same rule as superseding: only a request still waiting on the customer
      // can gain evidence; an answered one is immutable.
      if (!['pending', 'partially_approved'].includes(request.status)) {
        throw new PricingError(409, 'REQUEST_CLOSED', 'Photos can only be added to a request that is still open');
      }
      if (existing.filter((p) => p.extraWorkRequestId === request.id).length + urls.length > MAX_REQUEST_PHOTOS) {
        throw new PricingError(409, 'PHOTO_LIMIT', `At most ${MAX_REQUEST_PHOTOS} photos per extra-work request`);
      }
    }

    await tx.bookingPhoto.createMany({
      data: urls.map((url) => ({
        bookingId: booking.id,
        extraWorkRequestId: kind === 'extra_work' ? requestId : null,
        kind,
        url,
        created_by: ctx.actorId,
      })),
    });
    return { status: 201, event: { type: 'photos_added', payload: { kind, requestId: kind === 'extra_work' ? requestId : null, count: urls.length } } };
  });

/** G06 "Parts used": a free-text note on the job timeline (BookingEvent 'parts_used'). */
export const recordPartsUsed = (ctx, note) =>
  runAction({ ...ctx, role: ROLE_VENDOR }, async (_tx, booking) => {
    requireCheckedIn(booking);
    requireActive(booking);
    if ((booking.bookingEvents ?? []).length >= MAX_PARTS_USED_NOTES) {
      throw new PricingError(409, 'NOTE_LIMIT', `At most ${MAX_PARTS_USED_NOTES} parts notes per booking`);
    }
    // runAction writes the audit row, which IS the record (no table of its own).
    return { status: 201, event: { type: PARTS_USED_EVENT, payload: { note: note.trim() } } };
  });

const DEAD_STATUSES = ['cancelled', 'canceled', 'refunded'];

/**
 * G05 "Call customer". The vendor already receives the customer's phone on
 * every booking row they own (util/publicVendor.js SAFE_CUSTOMER_SELECT), so
 * this widens nothing; it only narrows: own booking, accepted, v2, not
 * cancelled/refunded. Name + phone only.
 */
export const getCustomerContact = async ({ bookingId, actorId }) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      vendor_status: true,
      service: { select: { vendorId: true } },
      bookingQuote: { select: { id: true } },
      user: { select: { userProfile: { select: { name: true, phone: true } } } },
    },
  });
  if (!booking) throw new PricingError(404, 'NOT_FOUND', 'Booking not found');
  if (booking.service?.vendorId !== actorId) throw new PricingError(403, 'FORBIDDEN', 'This booking is not yours');
  if (!booking.bookingQuote) throw new PricingError(409, 'NOT_V2', 'This booking uses the old pricing flow');
  if (booking.vendor_status !== 'accepted' || DEAD_STATUSES.includes(booking.status)) {
    throw new PricingError(409, 'INVALID_STATE', `The customer's number is not available for a ${booking.status} booking`);
  }
  const profile = booking.user?.userProfile;
  return { booking_id: booking.id, name: profile?.name ?? null, phone: profile?.phone ?? null };
};

/**
 * Mint the short-lived signed token for GET /bills/:id/view (util/billToken.js).
 * Either party of the booking may ask; a void or missing bill has nothing to show.
 */
export const createBillLink = async ({ bookingId, role, actorId }) => {
  const booking = await loadOwned(prisma, bookingId, role, actorId);
  if (!booking.bookingQuote) throw new PricingError(409, 'NOT_V2', 'This booking uses the old pricing flow');
  const bill = openBillOf(booking.finalBills);
  if (!bill) throw new PricingError(409, 'BILL_NOT_ISSUED', 'There is no bill for this booking yet');
  let signed;
  try {
    signed = signBillToken({ billId: bill.id, role, actorId });
  } catch (err) {
    // BILL_LINK_SECRET not configured: no default key is ever used.
    if (err instanceof BillLinkUnavailableError) {
      throw new PricingError(503, 'BILL_LINK_UNAVAILABLE', 'Bill download is temporarily unavailable');
    }
    throw err;
  }
  const { token, expiresAt } = signed;
  return { bill_id: bill.id, token, expires_at: expiresAt.toISOString() };
};

export const requestExtraWork = (ctx, body) =>
  runAction({ ...ctx, role: ROLE_VENDOR }, async (tx, booking) => {
    requireCheckedIn(booking);
    requireActive(booking);
    requireNoOpenBill(booking);

    const requests = booking.extraWorkRequests ?? [];

    let superseded = null;
    if (body.supersedes_id != null) {
      superseded = requests.find((r) => r.id === body.supersedes_id) ?? null;
      if (!superseded) throw new PricingError(404, 'NOT_FOUND', 'The request to replace was not found on this booking');
      if (!['pending', 'partially_approved'].includes(superseded.status)) {
        throw new PricingError(409, 'REQUEST_CLOSED', 'Only a pending or partly answered request can be replaced');
      }
    }

    // Quote lines already being removed (approved, or still pending in a
    // request that stays open) cannot be removed a second time -- the bill
    // would otherwise subtract the same line twice.
    const takenQuoteLines = new Set();
    for (const r of requests) {
      for (const i of r.items ?? []) {
        if (i.kind !== 'removal' || i.quote_line_id == null) continue;
        const stillLive = i.decision === 'approved' || (i.decision === 'pending' && r.id !== superseded?.id);
        if (stillLive) takenQuoteLines.add(i.quote_line_id);
      }
    }
    const quoteLinesById = new Map((booking.bookingQuote.lines ?? []).map((l) => [l.id, l]));

    const items = body.items.map((item, index) => {
      if (item.kind === 'removal') {
        const line = quoteLinesById.get(item.quote_line_id);
        if (!line || takenQuoteLines.has(item.quote_line_id)) {
          throw new PricingError(409, 'INVALID_QUOTE_LINE', 'That quote line cannot be removed');
        }
        takenQuoteLines.add(item.quote_line_id);
        // The server derives a removal's amount from the quote line; the
        // body's qty / unit_price are ignored (contract section 4).
        const totalPaise = lineTotalPaise(line.qty, line.unit_price);
        return {
          kind: 'removal',
          name: (item.name ?? '').trim() || `Remove: ${line.name}`.slice(0, 80),
          qty: num(line.qty),
          unit_price: -num(line.unit_price),
          line_total: fromPaise(-totalPaise),
          quote_line_id: line.id,
          sort_order: index,
        };
      }
      return {
        kind: item.kind,
        name: item.name.trim(),
        qty: item.qty,
        unit_price: item.unit_price,
        line_total: fromPaise(lineTotalPaise(item.qty, item.unit_price)),
        quote_line_id: null,
        sort_order: index,
      };
    });

    if (superseded) {
      // Approved items of the old request stay approved (owner rule: an
      // approved line is never edited); only its undecided items go.
      await tx.extraWorkItem.updateMany({
        where: { requestId: superseded.id, decision: 'pending' },
        data: { decision: 'superseded' },
      });
      await tx.extraWorkRequest.update({ where: { id: superseded.id }, data: { status: 'superseded' } });
    }

    const number = requests.reduce((max, r) => Math.max(max, r.number ?? 0), 0) + 1;
    const created = await tx.extraWorkRequest.create({
      data: {
        bookingId: booking.id,
        number,
        reason: body.reason.trim(),
        supersedes_id: superseded?.id ?? null,
        created_by: ctx.actorId,
        items: { create: items },
      },
    });

    return {
      status: 201,
      event: {
        type: 'extra_work_requested',
        payload: { requestId: created.id, number, supersedes_id: superseded?.id ?? null, item_count: items.length },
      },
      notify: [{ type: NOTIFICATION_TYPES.EXTRA_WORK_REQUESTED, to: ROLE_USER, vars: { requestId: created.id } }],
      extra: { request_id: created.id },
    };
  });

/** Calendar year in India, for the bill number ("KPX-2026-000123"). */
const istYear = (date = new Date()) => new Date(date.getTime() + 330 * 60 * 1000).getUTCFullYear();

export const issueFinalBill = (ctx) =>
  runAction({ ...ctx, role: ROLE_VENDOR }, async (tx, booking) => {
    requireCheckedIn(booking);

    // Idempotent: a second tap (or a retry after a lost response) returns
    // the bill that already exists instead of failing or issuing another.
    if (openBillOf(booking.finalBills)) return { extra: { lapsed_item_ids: [] } };
    requireActive(booking);

    // Pending items are left off the bill (owner rule). The client warns
    // first; lapsing them here keeps the record honest about why.
    const requests = booking.extraWorkRequests ?? [];
    const lapsedIds = requests.flatMap((r) => (r.items ?? []).filter((i) => i.decision === 'pending').map((i) => i.id));
    if (lapsedIds.length > 0) {
      await tx.extraWorkItem.updateMany({
        where: { id: { in: lapsedIds }, decision: 'pending' },
        data: { decision: 'lapsed' },
      });
    }

    const latestRequestId = requests.reduce((best, r) => (!best || r.number > best.number ? r : best), null)?.id ?? null;

    const built = buildBillLines({
      quote: booking.bookingQuote,
      quoteLines: [...(booking.bookingQuote.lines ?? [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
      approvedItems: approvedItemsOf(requests),
    });

    // Owner decision 2026-11-21: Razorpay's minimum charge is ₹1, so a bill
    // between ₹0 and ₹1 could never be paid. Refuse it (the garage adjusts
    // lines) rather than forgiving money. The throw rolls back any lapsing.
    if (built.totalPaise > 0 && built.totalPaise < 100) {
      throw new PricingError(422, 'BILL_TOO_SMALL', 'A bill must be ₹0 or at least ₹1. Adjust the lines and try again.');
    }
    // Owner decision 2026-11-21: a ₹0 bill cannot go through Razorpay either,
    // so it is created already 'paid' (no Payment row, no fee, no payout).
    const noCharge = built.totalPaise === 0;

    // Counter table instead of a SEQUENCE (prisma db push cannot create
    // one). INSERT ... ON CONFLICT ... RETURNING is a single atomic statement.
    const year = istYear();
    const rows = await tx.$queryRaw`
      INSERT INTO "BillNumberCounter" ("year", "last") VALUES (${year}, 1)
      ON CONFLICT ("year") DO UPDATE SET "last" = "BillNumberCounter"."last" + 1
      RETURNING "last"`;
    const seq = Number(rows?.[0]?.last);
    if (!Number.isInteger(seq) || seq < 1) throw new Error('Bill number counter returned no value');
    const number = `KPX-${year}-${String(seq).padStart(6, '0')}`;

    const bill = await tx.finalBill.create({
      data: {
        bookingId: booking.id,
        // Unique column: a second open bill for this booking is impossible
        // even if the advisory lock were bypassed.
        open_booking_id: booking.id,
        number,
        status: noCharge ? 'paid' : 'issued',
        paid_at: noCharge ? new Date() : null,
        labour_total: built.labour_total,
        parts_total: built.parts_total,
        total: built.total,
        issued_by: ctx.actorId,
        lines: {
          create: built.lines.map((l, i) => ({
            kind: l.kind,
            name: l.name.slice(0, 80),
            qty: l.qty,
            unit_price: l.unit_price,
            line_total: l.line_total,
            source: l.source,
            source_id: l.source_id ?? null,
            sort_order: i,
          })),
        },
      },
    });

    if (noCharge) {
      return {
        status: 201,
        event: { type: 'final_bill_no_charge', payload: { billId: bill.id, number, total: 0, lapsed_item_ids: lapsedIds } },
        notify: [{ type: NOTIFICATION_TYPES.FINAL_BILL_NO_CHARGE, to: ROLE_USER, vars: { billId: bill.id } }],
        extra: { lapsed_item_ids: lapsedIds },
      };
    }

    return {
      status: 201,
      event: { type: 'final_bill_issued', payload: { billId: bill.id, number, total: built.total, lapsed_item_ids: lapsedIds } },
      notify: [{
        type: NOTIFICATION_TYPES.FINAL_BILL_ISSUED,
        to: ROLE_USER,
        // A bill has no single request; the latest one (if any) is sent for
        // the app's deep link, with the bill id.
        vars: { amount: built.total, billId: bill.id, requestId: latestRequestId },
      }],
      extra: { lapsed_item_ids: lapsedIds },
    };
  });

export const voidFinalBill = (ctx, body) =>
  runAction({ ...ctx, role: ROLE_VENDOR }, async (tx, booking) => {
    const bill = openBillOf(booking.finalBills);
    if (!bill) throw new PricingError(409, 'BILL_NOT_ISSUED', 'There is no issued bill to void');
    // A captured payment settles the bill; money already taken must go
    // through the refund path, not a void.
    if (bill.status === 'paid' || booking.payment?.status === 'success') {
      throw new PricingError(409, 'BILL_PAID', 'This bill has been paid and cannot be voided');
    }

    const { count } = await tx.finalBill.updateMany({
      where: { id: bill.id, status: 'issued' },
      data: {
        status: 'void',
        // Frees the unique slot so a corrected bill can be issued.
        open_booking_id: null,
        voided_at: new Date(),
        voided_by: ctx.actorId,
        void_reason: body.reason.trim(),
      },
    });
    if (count === 0) throw new PricingError(409, 'BILL_PAID', 'This bill has been paid and cannot be voided');

    return {
      event: { type: 'final_bill_voided', payload: { billId: bill.id, number: bill.number, reason: body.reason.trim() } },
      notify: [{ type: NOTIFICATION_TYPES.FINAL_BILL_VOIDED, to: ROLE_USER }],
    };
  });

// ---------------------------------------------------------------------------
// Customer actions (section 5). The vendor has no route to these.
// ---------------------------------------------------------------------------

/**
 * Request status from its items' final decisions:
 * approved = all decided, none rejected; rejected = all rejected;
 * partially_approved = some decided; pending = none decided.
 * Superseded / lapsed items count as decided-not-approved.
 */
export const requestStatusFor = (items) => {
  const decisions = items.map((i) => i.decision);
  if (decisions.length === 0) return 'pending';
  const pending = decisions.filter((d) => d === 'pending').length;
  if (pending === decisions.length) return 'pending';
  if (pending > 0) return 'partially_approved';
  if (decisions.every((d) => d === 'approved')) return 'approved';
  if (decisions.every((d) => d === 'rejected')) return 'rejected';
  return 'partially_approved';
};

const findRequest = (booking, requestId) => {
  const request = (booking.extraWorkRequests ?? []).find((r) => r.id === requestId);
  if (!request) throw new PricingError(404, 'NOT_FOUND', 'Extra-work request not found');
  return request;
};

export const decideExtraWork = (ctx, requestId, body, appVersion) =>
  runAction({ ...ctx, role: ROLE_USER }, async (tx, booking) => {
    const request = findRequest(booking, requestId);
    if (request.status === 'superseded') {
      throw new PricingError(409, 'REQUEST_CLOSED', 'The garage replaced this request with a newer one');
    }
    requireNoOpenBill(booking);

    const approve = [...new Set(body.approve ?? [])];
    const reject = [...new Set(body.reject ?? [])];
    if (approve.some((id) => reject.includes(id))) {
      throw new PricingError(400, 'VALIDATION_ERROR', 'An item cannot be both approved and rejected');
    }

    const pendingIds = new Set((request.items ?? []).filter((i) => i.decision === 'pending').map((i) => i.id));
    if ([...approve, ...reject].some((id) => !pendingIds.has(id))) {
      throw new PricingError(409, 'ITEM_NOT_PENDING', 'One or more items are not waiting for a decision');
    }

    const decidedAt = new Date();
    const stamp = {
      decided_at: decidedAt,
      decided_by: ctx.actorId,
      app_version: typeof appVersion === 'string' && appVersion.trim() ? appVersion.trim().slice(0, 40) : null,
    };
    // Guarded on decision 'pending' and count-checked: if anything changed
    // since the read, the throw rolls back the whole decision (nothing is
    // half-applied).
    for (const [ids, decision] of [[approve, 'approved'], [reject, 'rejected']]) {
      if (ids.length === 0) continue;
      const { count } = await tx.extraWorkItem.updateMany({
        where: { id: { in: ids }, requestId: request.id, decision: 'pending' },
        data: { decision, ...stamp },
      });
      if (count !== ids.length) {
        throw new PricingError(409, 'ITEM_NOT_PENDING', 'One or more items are not waiting for a decision');
      }
    }

    const nextItems = (request.items ?? []).map((i) => ({
      ...i,
      decision: approve.includes(i.id) ? 'approved' : reject.includes(i.id) ? 'rejected' : i.decision,
    }));
    const status = requestStatusFor(nextItems);
    await tx.extraWorkRequest.update({ where: { id: request.id }, data: { status } });

    return {
      event: { type: 'extra_work_decided', payload: { requestId: request.id, approved: approve, rejected: reject, status } },
      notify: [{
        type: NOTIFICATION_TYPES.EXTRA_WORK_DECIDED,
        to: ROLE_VENDOR,
        vars: { requestId: request.id, approvedCount: approve.length, rejectedCount: reject.length },
      }],
    };
  });

export const requestCall = (ctx, requestId) =>
  runAction({ ...ctx, role: ROLE_USER }, async (tx, booking) => {
    const request = findRequest(booking, requestId);
    if (!['pending', 'partially_approved'].includes(request.status)) {
      throw new PricingError(409, 'REQUEST_CLOSED', 'This request has no items waiting for a decision');
    }
    // Only a timestamp: asking for a call never approves or rejects anything.
    await tx.extraWorkRequest.update({ where: { id: request.id }, data: { call_requested_at: new Date() } });
    return {
      event: { type: 'extra_work_call_requested', payload: { requestId: request.id } },
      notify: [{ type: NOTIFICATION_TYPES.EXTRA_WORK_CALL_REQUESTED, to: ROLE_VENDOR, vars: { requestId: request.id } }],
    };
  });

// Exported for tests.
export const __test = { istYear, toPaise };

/**
 * Controller helper: a PricingError becomes `{success:false, message, code}`
 * with its status; anything else is a 500 (logged, details not leaked).
 */
export const sendPricingError = (res, err, label) => {
  if (err instanceof PricingError) {
    return res.status(err.status).json({ success: false, message: err.message, code: err.code });
  }
  // The open_booking_id unique index is the backstop behind the advisory
  // lock: if it ever fires, a bill already exists -- report it as such.
  if (err?.code === 'P2002' && String(err?.meta?.target ?? '').includes('open_booking_id')) {
    return res.status(409).json({ success: false, message: 'A final bill already exists for this booking', code: 'BILL_EXISTS' });
  }
  console.error(`[pricingV2] ${label} failed:`, err);
  return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.', code: 'INTERNAL_SERVER_ERROR' });
};
