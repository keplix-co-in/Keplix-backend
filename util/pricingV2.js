/**
 * Pricing v2 shape helpers (docs/PRICING_V2_API.md). Pure functions: no
 * Prisma, no I/O. The database work lives in services/pricingV2Service.js;
 * the money arithmetic in util/billMath.js.
 *
 *  - serializeServicePricing: the v2 fields every service response carries
 *    (section 1), including legacy lines synthesised for services saved
 *    before v2 existed (no data migration needed).
 *  - planServicePricingWrite: turns a validated create/update body into the
 *    Service columns, the price lines to store and the segment prices to
 *    upsert/delete. The server, not the client, computes Service.price.
 *  - buildQuoteSnapshot: what a v2 booking freezes at creation (section 2).
 *  - buildPricingView + computeCan: the pricing object (section 3).
 */
import { buildBillLines, fromPaise, lineTotalPaise, summarizeLines, toPaise } from './billMath.js';

export const PRICING_TYPES = ['fixed', 'starting', 'inspection'];
export const VEHICLE_SEGMENTS = ['HATCHBACK', 'SEDAN', 'COMPACT_SUV', 'MUV', 'LUXURY'];
export const LEGACY_LINE_NAME = 'Service charge';
export const INSPECTION_LINE_NAME = 'Inspection fee';

// Booking statuses in which post-check-in workshop actions make sense.
// service_completed is included so a bill voided after completion can be
// corrected and re-issued (completion itself requires an issued bill).
export const V2_ACTIVE_STATUSES = ['in_progress', 'service_completed'];
// Check-in starts the job from an accepted, not-yet-started booking.
// in_progress is accepted too (only when no check-in exists yet): an
// accepted early-start request (respondToEarlyStart) moves a booking to
// in_progress on its own, and without this the garage could never check
// that car in. Deviation from the contract, documented there.
export const CHECK_IN_FROM_STATUSES = ['confirmed', 'scheduled'];
export const CHECK_IN_EXTRA_STATUSES = ['in_progress'];

const num = (v) => (v === null || v === undefined ? null : Number(v.toString()));

const sortLines = (lines) =>
  [...(lines ?? [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.id ?? 0) - (b.id ?? 0));

const lineOut = (l) => ({
  id: l.id ?? null,
  segment: l.segment ?? null,
  kind: l.kind,
  name: l.name,
  qty: num(l.qty),
  unit_price: num(l.unit_price),
  line_total: fromPaise(lineTotalPaise(l.qty, l.unit_price)),
});

/**
 * The lines a legacy service (no stored price lines) is shown with: one base
 * labour line for `price`, plus one labour line per segment price. Same shape
 * the create/update path stores for a legacy payload, so a legacy service
 * reads identically before and after its next save.
 */
export const synthesiseLegacyLines = (price, segmentPrices = []) => [
  { id: null, segment: null, kind: 'labour', name: LEGACY_LINE_NAME, qty: 1, unit_price: num(price) ?? 0 },
  ...(segmentPrices ?? []).map((sp) => ({
    id: null,
    segment: sp.segment,
    kind: 'labour',
    name: LEGACY_LINE_NAME,
    qty: 1,
    unit_price: num(sp.price) ?? 0,
  })),
];

/**
 * Section 1 response fields for one service. `service.priceLines` and
 * `service.segmentPrices` should be included by the caller; when priceLines
 * is empty the legacy lines are synthesised and breakdown_confirmed is false.
 */
export const serializeServicePricing = (service, { priceLines, segmentPrices } = {}) => {
  const stored = sortLines(priceLines ?? service.priceLines ?? []);
  const pricingType = PRICING_TYPES.includes(service.pricing_type) ? service.pricing_type : 'fixed';
  const synthesised = stored.length === 0 && pricingType !== 'inspection';
  const lines = synthesised
    ? synthesiseLegacyLines(service.price, segmentPrices ?? service.segmentPrices ?? [])
    : stored;

  const baseLines = lines.filter((l) => !l.segment);
  let { labour_total: labourTotal, parts_total: partsTotal } = summarizeLines(baseLines);
  // An inspection service usually has no lines: its base price is the fee,
  // which becomes a labour line on the booking quote (section 2).
  if (pricingType === 'inspection' && baseLines.length === 0) {
    labourTotal = fromPaise(toPaise(service.inspection_fee ?? 0));
    partsTotal = 0;
  }

  return {
    pricing_type: pricingType,
    price_lines: lines.map(lineOut),
    inclusions: service.inclusions ?? [],
    exclusions: service.exclusions ?? [],
    price_change_note: service.price_change_note ?? null,
    inspection_fee: num(service.inspection_fee),
    tax_inclusive: service.tax_inclusive ?? true,
    breakdown_confirmed: synthesised ? false : Boolean(service.breakdown_confirmed),
    labour_total: labourTotal,
    parts_total: partsTotal,
  };
};

/** Service object + its v2 fields, for responses that return the raw row. */
export const withServicePricing = (service) => {
  if (!service) return service;
  const { priceLines: _omit, ...rest } = service;
  return { ...rest, ...serializeServicePricing(service) };
};

/**
 * Sum of each segment's lines, in rupees: { base, segments: Map(segment -> rupees) }.
 */
const totalsBySegment = (lines) => {
  const groups = new Map();
  for (const l of lines) {
    const key = l.segment ?? null;
    groups.set(key, (groups.get(key) ?? 0) + lineTotalPaise(l.qty, l.unit_price));
  }
  const segments = new Map();
  for (const [key, paise] of groups) if (key) segments.set(key, fromPaise(paise));
  return { basePaise: groups.get(null) ?? 0, segments };
};

/**
 * Plan the pricing part of a service write.
 *
 * @param {object} input validated body fields plus, for updates, the current row:
 *   { pricing_type, price_lines, inspection_fee, price, segment_prices }
 * @returns {{ price:number, lines:Array|null, segmentPrices:Array<{segment,price}>|null,
 *             breakdownConfirmed:boolean, pricingType:string }}
 *   lines/segmentPrices null = leave the stored ones untouched.
 *
 * v2 (price_lines present, or inspection): Service.price and the segment
 * prices are DERIVED from the lines and the client's price/segment_prices
 * are ignored -- a client can never send a total that disagrees with its own
 * lines. Legacy (no price_lines): price/segment_prices behave exactly as
 * before, and the matching synthetic lines are stored alongside.
 */
export const planServicePricingWrite = ({ pricing_type, price_lines, inspection_fee, price, segment_prices }) => {
  const pricingType = pricing_type ?? 'fixed';

  if (Array.isArray(price_lines) || pricingType === 'inspection') {
    const lines = (price_lines ?? []).map((l, i) => ({
      segment: l.segment ?? null,
      kind: l.kind,
      name: l.name,
      qty: l.qty,
      unit_price: l.unit_price,
      sort_order: i,
    }));
    const { basePaise, segments } = totalsBySegment(lines);
    const basePrice = pricingType === 'inspection' && !lines.some((l) => !l.segment)
      ? fromPaise(toPaise(inspection_fee ?? 0))
      : fromPaise(basePaise);
    return {
      pricingType,
      price: basePrice,
      lines,
      segmentPrices: [...segments].map(([segment, p]) => ({ segment, price: p })),
      // Only real vendor-entered lines count as a confirmed breakdown.
      breakdownConfirmed: Array.isArray(price_lines),
    };
  }

  // Legacy payload.
  const segs = Array.isArray(segment_prices) ? segment_prices : null;
  return {
    pricingType: 'fixed',
    price: price,
    lines: synthesiseLegacyLines(price, segs ?? []).map((l, i) => ({
      segment: l.segment,
      kind: l.kind,
      name: l.name,
      qty: l.qty,
      unit_price: l.unit_price,
      sort_order: i,
    })),
    segmentPrices: segs,
    breakdownConfirmed: false,
  };
};

/**
 * Section 2: what a v2 booking freezes at creation.
 *
 * Lines: the booking segment's own lines when that segment has any, else the
 * base lines. A legacy service (no stored lines) snapshots one "Service
 * charge" line at `fallbackAmount` -- the same resolved price written to
 * BookingVehicle.price_snapshot, so the two snapshots can never disagree.
 * 'inspection' snapshots exactly one labour line for the fee.
 */
export const buildQuoteSnapshot = (service, segment, fallbackAmount) => {
  const pricingType = PRICING_TYPES.includes(service.pricing_type) ? service.pricing_type : 'fixed';
  const stored = sortLines(service.priceLines ?? []);

  let lines;
  if (pricingType === 'inspection') {
    // Owner decision 2026-11-21: fee 0/null = free inspection. Snapshot NO
    // "Inspection fee" line (quote has zero lines, total 0) rather than a ₹0 line.
    const fee = num(service.inspection_fee) ?? 0;
    lines = fee > 0 ? [{ kind: 'labour', name: INSPECTION_LINE_NAME, qty: 1, unit_price: fee }] : [];
  } else if (stored.length === 0) {
    lines = [{ kind: 'labour', name: LEGACY_LINE_NAME, qty: 1, unit_price: Number(fallbackAmount) || 0 }];
  } else {
    const segLines = segment ? stored.filter((l) => l.segment === segment) : [];
    const chosen = segLines.length > 0 ? segLines : stored.filter((l) => !l.segment);
    lines = chosen.map((l) => ({ kind: l.kind, name: l.name, qty: num(l.qty), unit_price: num(l.unit_price) }));
  }

  return {
    quote: {
      pricing_type: pricingType,
      segment: segment ?? null,
      inclusions: service.inclusions ?? [],
      exclusions: service.exclusions ?? [],
      price_change_note: service.price_change_note ?? null,
      inspection_fee: pricingType === 'inspection' ? num(service.inspection_fee) ?? 0 : null,
      tax_inclusive: service.tax_inclusive ?? true,
    },
    lines: lines.map((l, i) => ({ ...l, sort_order: i })),
  };
};

/** The single non-void bill of a booking (issued or paid), or null. */
export const openBillOf = (finalBills) =>
  (finalBills ?? []).find((b) => b.status === 'issued' || b.status === 'paid') ?? null;

/** Approved items across all requests, oldest request first. */
export const approvedItemsOf = (requests) =>
  [...(requests ?? [])]
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
    .flatMap((r) => sortLines(r.items).filter((i) => i.decision === 'approved'));

const iso = (d) => (d ? new Date(d).toISOString() : null);

const itemOut = (i) => ({
  id: i.id,
  kind: i.kind,
  name: i.name,
  qty: num(i.qty),
  unit_price: num(i.unit_price),
  line_total: num(i.line_total),
  quote_line_id: i.quote_line_id ?? null,
  // Part + labour of one job share a job_key; apps group by it (2026-11-22).
  job_key: i.job_key ?? null,
  decision: i.decision,
  decided_at: iso(i.decided_at),
});

const photoOut = (p) => ({ id: p.id, url: p.url, created_at: iso(p.createdAt) });

// Photos of one kind / one request, oldest first.
const photosWhere = (photos, pred) =>
  [...(photos ?? [])]
    .filter(pred)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || a.id - b.id)
    .map(photoOut);

const requestOut = (r, photos = []) => {
  const items = sortLines(r.items);
  const sum = (pred) => fromPaise(items.filter(pred).reduce((acc, i) => acc + toPaise(i.line_total), 0));
  return {
    id: r.id,
    number: r.number,
    reason: r.reason,
    status: r.status,
    supersedes_id: r.supersedes_id ?? null,
    call_requested_at: iso(r.call_requested_at),
    created_at: iso(r.createdAt),
    // Garage photos for this request, shown on the customer's approval screen.
    photos: photosWhere(photos, (p) => p.kind === 'extra_work' && p.extraWorkRequestId === r.id),
    items: items.map(itemOut),
    approved_total: sum((i) => i.decision === 'approved'),
    pending_total: sum((i) => i.decision === 'pending'),
  };
};

/**
 * `tax_inclusive` comes from the booking quote: the bill is built from the
 * quote's prices, so it carries the same tax treatment (no column on FinalBill).
 */
export const billOut = (bill, quote = null) =>
  bill
    ? {
        id: bill.id,
        number: bill.number,
        status: bill.status,
        lines: sortLines(bill.lines).map((l) => ({
          kind: l.kind,
          name: l.name,
          qty: num(l.qty),
          unit_price: num(l.unit_price),
          line_total: num(l.line_total),
          source: l.source,
        })),
        labour_total: num(bill.labour_total),
        parts_total: num(bill.parts_total),
        total: num(bill.total),
        tax_inclusive: quote?.tax_inclusive ?? true,
        issued_at: iso(bill.issued_at),
        paid_at: iso(bill.paid_at),
        paid_method: bill.paid_method ?? null,
      }
    : null;


/**
 * Section 3 `can` flags, for the caller's role. Clients show buttons from
 * these and never from their own logic, so every rule the endpoints enforce
 * is mirrored here.
 */
export const computeCan = (booking, role) => {
  const can = {
    check_in: false,
    start_inspection: false,
    start_work: false,
    complete_work: false,
    request_extra_work: false,
    issue_bill: false,
    void_bill: false,
    pay: false,
    mark_paid: false,
  };
  if (!booking?.bookingQuote) return can;

  const job = booking.bookingJob ?? null;
  const bill = openBillOf(booking.finalBills);
  const accepted = booking.vendor_status === 'accepted';
  const active = accepted && Boolean(job) && V2_ACTIVE_STATUSES.includes(booking.status);

  if (role === 'vendor') {
    can.check_in =
      accepted &&
      !job &&
      (CHECK_IN_FROM_STATUSES.includes(booking.status) || CHECK_IN_EXTRA_STATUSES.includes(booking.status));
    can.start_inspection = active && !bill && !job.inspection_started_at && !job.work_completed_at;
    can.start_work = active && !bill && !job.work_started_at;
    can.complete_work = active && Boolean(job.work_started_at) && !job.work_completed_at;
    can.request_extra_work = active && !bill;
    can.issue_bill = active && !bill;
    can.void_bill = active && bill?.status === 'issued';
    // Garage confirms it was paid directly (cash/UPI/card); an issued bill only.
    can.mark_paid = accepted && Boolean(job) && V2_ACTIVE_STATUSES.includes(booking.status) && bill?.status === 'issued';
  } else if (role === 'user') {
    // PAY AT THE GARAGE (owner decision 2026-11-22): the customer never pays or
    // confirms payment in the app, so `pay` stays false. The garage marks the
    // bill paid (can.mark_paid on the vendor side).
    can.pay = false;
  }
  return can;
};

/**
 * Section 3 pricing object. `booking` must be loaded with
 * PRICING_BOOKING_INCLUDE (services/pricingV2Service.js).
 */
export const buildPricingView = (booking, role) => {
  const quote = booking?.bookingQuote;
  if (!quote) return { flow: 'legacy' };

  const quoteLines = sortLines(quote.lines);
  const quoteTotals = summarizeLines(quoteLines);
  const bill = openBillOf(booking.finalBills);
  const job = booking.bookingJob ?? null;

  // running_total = quote + approved items, plus the waiver once a bill
  // exists. With a bill, the bill's own stored total IS that number.
  let runningTotal;
  if (bill) {
    runningTotal = num(bill.total);
  } else {
    runningTotal = buildBillLines({
      quote: { ...quote, pricing_type: null }, // no waiver before the bill
      quoteLines,
      approvedItems: approvedItemsOf(booking.extraWorkRequests),
    }).total;
  }

  return {
    flow: 'v2',
    quote: {
      pricing_type: quote.pricing_type,
      segment: quote.segment ?? null,
      inclusions: quote.inclusions ?? [],
      exclusions: quote.exclusions ?? [],
      price_change_note: quote.price_change_note ?? '',
      inspection_fee: num(quote.inspection_fee),
      tax_inclusive: quote.tax_inclusive ?? true,
      lines: quoteLines.map((l) => {
        const { segment: _s, ...rest } = lineOut(l);
        return rest;
      }),
      labour_total: quoteTotals.labour_total,
      parts_total: quoteTotals.parts_total,
      total: quoteTotals.total,
    },
    job: {
      checked_in_at: iso(job?.checked_in_at),
      odometer_km: job?.odometer_km ?? null,
      fuel_level: job?.fuel_level ?? null,
      condition_note: job?.condition_note ?? null,
      inspection_started_at: iso(job?.inspection_started_at),
      work_started_at: iso(job?.work_started_at),
      work_completed_at: iso(job?.work_completed_at),
      // Check-in photos (G03) and "parts used" notes (G06). Both come from
      // side tables (BookingPhoto / BookingEvent type 'parts_used'); the job
      // row itself has no column for either.
      photos: photosWhere(booking.bookingPhotos, (p) => p.kind === 'check_in'),
      parts_used: [...(booking.bookingEvents ?? [])]
        .filter((e) => e.type === PARTS_USED_EVENT)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || a.id - b.id)
        .map((e) => ({ note: e.payload?.note ?? '', at: iso(e.created_at) })),
    },
    requests: [...(booking.extraWorkRequests ?? [])]
      .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
      .map((r) => requestOut(r, booking.bookingPhotos)),
    bill: billOut(bill, quote),
    // Where the customer pays (2026-11-22 pay-the-garage decision): the garage's
    // UPI id for the QR on the customer's bill screen. upi_id may be null.
    pay_to: {
      upi_id: booking.service?.vendor?.vendorProfile?.upi_id ?? null,
      garage_name: booking.service?.vendor?.vendorProfile?.business_name ?? null,
    },
    running_total: runningTotal,
    can: computeCan(booking, role),
  };
};

/** BookingEvent.type for the "parts used" step (G06). No schema change needed. */
export const PARTS_USED_EVENT = 'parts_used';

/**
 * Prisma include fragment for withPricingFlow: the quote id (is it v2?) and
 * the open bill's status/total (list rows show "Bill ready" / "Paid" and the
 * amount). Both come from side tables; Booking has no columns for them.
 */
export const PRICING_FLOW_INCLUDE = {
  bookingQuote: { select: { id: true } },
  finalBills: { where: { status: { in: ['issued', 'paid'] } }, select: { status: true, total: true, number: true } },
};

/**
 * Booking list/detail rows get `pricing_flow: 'v2' | 'legacy'` (derived from
 * whether a BookingQuote exists -- there is no Booking column for it), so
 * the apps know which payment flow applies without an extra /pricing call.
 * The raw bookingQuote relation is dropped from the response.
 *
 * v2 rows also get bill_status ('issued' | 'paid', or null while no bill is
 * open) and bill_total (rupees, or null). Legacy rows get both as null.
 */
export const withPricingFlow = (booking) => {
  if (!booking) return booking;
  const { bookingQuote, finalBills, ...rest } = booking;
  const bill = bookingQuote ? openBillOf(finalBills) : null;
  return {
    ...rest,
    pricing_flow: bookingQuote ? 'v2' : 'legacy',
    bill_status: bill?.status ?? null,
    bill_total: bill ? num(bill.total) : null,
  };
};
