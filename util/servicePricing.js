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

export default { resolveServiceAmount, resolveBookingAmount };
