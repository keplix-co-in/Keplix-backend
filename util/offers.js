/**
 * One place that decides whether an offer slot is live.
 *
 * Mirrors util/platformSettings.js: the "is this gate on right now" decision
 * lives in a single function so the admin view, the public endpoint and any
 * future consumer can never disagree about it.
 *
 * A slot is live when it is active AND the current time falls inside its window.
 * Null bounds are open-ended, so a slot with no dates is simply "on while
 * active" — which is the common case and must not require the admin to pick
 * dates they don't care about.
 */
export function isOfferLive(slot, now = new Date()) {
  if (!slot || !slot.is_active) return false;
  if (slot.starts_at && now < slot.starts_at) return false;
  if (slot.ends_at && now > slot.ends_at) return false;
  return true;
}

/**
 * The public shape of a slot.
 *
 * Deliberately omits discount_type/discount_value: those columns exist for a
 * future real-discount feature and nothing may act on them yet. Exposing them
 * now would invite a client to start applying discounts the payment path knows
 * nothing about.
 *
 * `vendor_ids` is flattened so a client can resolve a per-vendor badge without a
 * second request. An EMPTY array means the slot applies to every vendor — see
 * the OfferSlotVendor comment in schema.prisma.
 */
export function toPublicOffer(slot) {
  return {
    key: slot.key,
    headline: slot.headline,
    body: slot.body,
    badge_text: slot.badge_text,
    image_url: slot.image_url,
    display_order: slot.display_order,
    vendor_ids: (slot.targets || []).map((t) => t.vendorId),
  };
}
