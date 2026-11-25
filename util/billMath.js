/**
 * Pricing v2 money math (docs/PRICING_V2_API.md, "Money").
 *
 * Everything is computed in INTEGER PAISE and only converted back to rupees
 * (a JS number with at most 2 decimals) at the edge. Floating-point rupees
 * drift: 0.1 + 0.2 !== 0.3, and a bill built from a dozen float additions can
 * come out a paisa off from the Razorpay order, which then fails the payment
 * amount check in util/paymentCharge.js. Pure functions only -- no Prisma, no
 * I/O -- so every rule here is unit-tested directly (tests/util/billMath.test.js).
 *
 * Inputs may be numbers, numeric strings or Prisma Decimals (anything whose
 * toString() is a number), because the same helpers run on request bodies and
 * on rows read back from Decimal(10,2) columns.
 */

const toNumber = (value) => {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(value.toString());
  if (!Number.isFinite(n)) {
    throw new TypeError(`billMath: not a finite amount: ${String(value)}`);
  }
  return n;
};

// Round half away from zero, so -2.5 paise and 2.5 paise round symmetrically
// (Math.round rounds -2.5 to -2, which would make a removal line and the
// line it removes differ by a paisa).
const roundHalfAway = (n) => Math.sign(n) * Math.round(Math.abs(n));

/** Rupees (number | string | Decimal) -> integer paise. */
export const toPaise = (rupees) => roundHalfAway(toNumber(rupees) * 100);

/** Integer paise -> rupees as a JS number with at most 2 decimals. */
export const fromPaise = (paise) => {
  const r = Math.round(paise) / 100;
  // Avoid "-0" in JSON for a zero total.
  return Object.is(r, -0) ? 0 : r;
};

/**
 * qty x unit_price, in paise. qty has at most 2 decimals (validated at the
 * boundary), so it is scaled to hundredths and multiplied as integers; the
 * product has 4 decimals of rupees and is rounded once, to the paisa.
 */
export const lineTotalPaise = (qty, unitPrice) => {
  const qtyHundredths = roundHalfAway(toNumber(qty) * 100);
  return roundHalfAway((qtyHundredths * toPaise(unitPrice)) / 100);
};

/** qty x unit_price, in rupees. */
export const lineTotal = (qty, unitPrice) => fromPaise(lineTotalPaise(qty, unitPrice));

/**
 * The paise value of a line: its stored line_total when it has one (removal
 * and waiver lines are stored with their negative total), else qty x price.
 */
const linePaise = (line) =>
  line.line_total !== undefined && line.line_total !== null
    ? toPaise(line.line_total)
    : lineTotalPaise(line.qty, line.unit_price);

/**
 * Labour / parts / total for a list of lines.
 *
 * A removal line counts against the kind of the quote line it removes
 * (`counts_as`), so taking a part off lowers parts_total, not labour. The
 * total is floored at 0 (contract: a bill total is never below 0); the
 * per-kind subtotals are floored at 0 too, since a negative "labour" figure
 * is meaningless to show a customer.
 *
 * @param {Array<{kind:string, qty?:any, unit_price?:any, line_total?:any, counts_as?:string}>} lines
 */
export const summarizeLinesPaise = (lines = []) => {
  let labour = 0;
  let parts = 0;
  let sum = 0;
  for (const line of lines) {
    const p = linePaise(line);
    const kind = line.counts_as ?? line.kind;
    if (kind === 'part') parts += p;
    else labour += p; // labour, the waiver, and any removal of a labour line
    sum += p;
  }
  return {
    labourPaise: Math.max(0, labour),
    partsPaise: Math.max(0, parts),
    totalPaise: Math.max(0, sum),
  };
};

export const summarizeLines = (lines = []) => {
  const { labourPaise, partsPaise, totalPaise } = summarizeLinesPaise(lines);
  return {
    labour_total: fromPaise(labourPaise),
    parts_total: fromPaise(partsPaise),
    total: fromPaise(totalPaise),
  };
};

/**
 * Inspection waiver (contract section 4): for an 'inspection' quote, when the
 * APPROVED, non-removal extra work adds up to at least the inspection fee,
 * the fee is waived. Returns the (negative) waiver in paise, or 0.
 *
 * Removals are excluded from the comparison on purpose: taking something off
 * the bill is not "repair work the customer approved", and counting it would
 * let a removal shrink the threshold.
 * A ₹0 fee never produces a waiver line -- there is nothing to waive.
 */
export const inspectionWaiverPaise = (quote, approvedItems = []) => {
  if (!quote || quote.pricing_type !== 'inspection') return 0;
  const feePaise = toPaise(quote.inspection_fee ?? 0);
  if (feePaise <= 0) return 0;
  const repairsPaise = approvedItems
    .filter((i) => i.kind !== 'removal')
    .reduce((acc, i) => acc + linePaise(i), 0);
  return repairsPaise >= feePaise ? -feePaise : 0;
};

export const WAIVER_LINE_NAME = 'Inspection fee waived';

/**
 * The final bill's lines and totals, from the quote and the approved extras.
 *
 * Only `approvedItems` are passed in: the caller (util/pricingV2.js) has
 * already dropped rejected, superseded, lapsed and pending items -- this
 * function has no notion of decisions, which keeps it trivially testable.
 * A quote line removed by more than one approved removal is only removed
 * once (defence in depth; the extra-work endpoint also refuses a second
 * removal of the same line).
 *
 * @param {{quote: object, quoteLines: Array, approvedItems: Array}} input
 * @returns {{lines: Array, labour_total:number, parts_total:number, total:number, totalPaise:number}}
 */
export const buildBillLines = ({ quote, quoteLines = [], approvedItems = [] }) => {
  const kindByQuoteLine = new Map(quoteLines.map((l) => [l.id, l.kind]));
  const lines = quoteLines.map((l) => ({
    kind: l.kind,
    name: l.name,
    qty: toNumber(l.qty),
    unit_price: toNumber(l.unit_price),
    line_total: fromPaise(lineTotalPaise(l.qty, l.unit_price)),
    source: 'quote',
    source_id: l.id ?? null,
  }));

  const removed = new Set();
  const counted = [];
  for (const item of approvedItems) {
    if (item.kind === 'removal') {
      if (item.quote_line_id == null || removed.has(item.quote_line_id)) continue;
      removed.add(item.quote_line_id);
    }
    counted.push(item);
    lines.push({
      kind: item.kind,
      counts_as: item.kind === 'removal' ? kindByQuoteLine.get(item.quote_line_id) ?? 'labour' : undefined,
      name: item.name,
      qty: toNumber(item.qty),
      unit_price: toNumber(item.unit_price),
      line_total: fromPaise(linePaise(item)),
      source: 'extra',
      source_id: item.id ?? null,
    });
  }

  const waiver = inspectionWaiverPaise(quote, counted);
  if (waiver !== 0) {
    lines.push({
      kind: 'labour',
      name: WAIVER_LINE_NAME,
      qty: 1,
      unit_price: fromPaise(waiver),
      line_total: fromPaise(waiver),
      source: 'waiver',
      source_id: null,
    });
  }

  const { labourPaise, partsPaise, totalPaise } = summarizeLinesPaise(lines);
  return {
    lines,
    labour_total: fromPaise(labourPaise),
    parts_total: fromPaise(partsPaise),
    total: fromPaise(totalPaise),
    totalPaise,
  };
};

export default {
  toPaise,
  fromPaise,
  lineTotalPaise,
  lineTotal,
  summarizeLines,
  summarizeLinesPaise,
  inspectionWaiverPaise,
  buildBillLines,
  WAIVER_LINE_NAME,
};
