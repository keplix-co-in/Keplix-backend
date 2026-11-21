/**
 * The single place a service's price is resolved for a given vehicle segment.
 *
 * There are THREE places in this codebase that turn "a booking" into "an
 * amount to charge": creating the Razorpay order (paymentController.js),
 * verifying a client-submitted payment, and reconciling a captured payment
 * from the webhook (both in paymentService.js). All three used to compute
 * `parseFloat(booking.service.price.toString())` independently. Segment
 * pricing means that expression is no longer the whole answer, and having it
 * duplicated three times is exactly how one of the three would be missed —
 * which, for a payment amount, is a silent under- or over-charge, not a
 * cosmetic bug. All three now call this.
 *
 * @param {{ price: import('@prisma/client').Prisma.Decimal|number|string, segmentPrices?: Array<{segment: string, price: any}> }} service
 * @param {string|null} [segment] a VehicleSegment value, or null/undefined for "no segment"
 * @returns {number} the resolved price, in rupees
 */
export function resolveServiceAmount(service, segment) {
  const base = parseFloat(service.price.toString());

  if (segment && Array.isArray(service.segmentPrices)) {
    const match = service.segmentPrices.find((sp) => sp.segment === segment);
    if (match) return parseFloat(match.price.toString());
  }

  // No segment, or no price recorded for it: the base price is not a
  // fallback bolted on after the fact, it's what every service already had
  // before this feature existed. A service with zero segment rows behaves
  // exactly as it always has.
  return base;
}

/**
 * The price to charge for an EXISTING booking.
 *
 * Once a booking has a BookingVehicle row, `price_snapshot` — not a fresh
 * lookup — is authoritative. Re-resolving from current prices at payment time
 * would let a vendor who edits their segment prices between booking and
 * payment retroactively change what an already-placed booking charges, which
 * is the entire reason BookingVehicle.price_snapshot exists.
 *
 * @param {{ service: object, bookingVehicle?: { price_snapshot: any, segment?: string|null } | null }} booking
 * @returns {number}
 */
export function resolveBookingAmount(booking) {
  if (booking.bookingVehicle) {
    return parseFloat(booking.bookingVehicle.price_snapshot.toString());
  }
  return resolveServiceAmount(booking.service, null);
}

/**
 * Pricing v2 (docs/PRICING_V2_API.md section 6). Add to every booking load
 * that feeds resolveChargeableAmount, next to service + bookingVehicle.
 * Only the open (issued/paid) bill is needed; a voided bill is never payable.
 */
export const V2_AMOUNT_INCLUDE = {
  bookingQuote: { select: { id: true } },
  finalBills: {
    where: { status: { in: ['issued', 'paid'] } },
    orderBy: { id: 'desc' },
    take: 1,
    select: { id: true, status: true, total: true },
  },
};

/**
 * The amount ALL THREE payment paths (order create, client verify, webhook /
 * reconciliation) charge for a booking. Same drift warning as above: if one
 * path resolved the amount differently, the capture cross-check would fail
 * every payment or record the wrong amount.
 *
 * - legacy booking (no BookingQuote): resolveBookingAmount, exactly as before.
 *   A booking loaded without V2_AMOUNT_INCLUDE has no `bookingQuote` key and is
 *   therefore treated as legacy -- deliberate, so older callers keep working.
 * - v2 booking: the total of its open final bill. No bill yet -> amount null
 *   (callers answer BILL_NOT_READY / reject the capture).
 *
 * @returns {{flow:'legacy'|'v2', amount:number|null, finalBillId:number|null, billStatus:string|null}}
 */
export function resolveChargeableAmount(booking) {
  if (!booking?.bookingQuote) {
    return { flow: 'legacy', amount: resolveBookingAmount(booking), finalBillId: null, billStatus: null };
  }
  const bill = (booking.finalBills ?? []).find((b) => b.status === 'issued' || b.status === 'paid') ?? null;
  if (!bill) return { flow: 'v2', amount: null, finalBillId: null, billStatus: null };
  return { flow: 'v2', amount: parseFloat(bill.total.toString()), finalBillId: bill.id, billStatus: bill.status };
}

export default { resolveServiceAmount, resolveBookingAmount, resolveChargeableAmount, V2_AMOUNT_INCLUDE };
