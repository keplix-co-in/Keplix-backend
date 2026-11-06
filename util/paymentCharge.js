import { resolveBookingAmount } from './servicePricing.js';
import { computeSplit, resolvePlatformFeeRate } from './platformSettings.js';

import { FEE_MODEL_ON_TOP, refundableBase } from './feeModel.js';

export { FEE_MODEL_ON_TOP, refundableBase };

/**
 * What a captured payment for this booking MUST be, and how it splits.
 *
 * WHY (2026-11-06, fee moved on top): the fee rate is frozen into the Razorpay
 * order's notes at order time. Verify, the webhook and the reconciliation cron
 * all call this so they agree, and an admin changing the rate between order
 * and capture can't make a valid payment fail its amount check or be split at
 * a rate the customer never saw.
 *
 * - notes.feeModel === 'on_top': amount = servicePrice + platformFee from the
 *   notes; vendor gets the full servicePrice. The notes are server-written,
 *   but servicePrice is still cross-checked against the booking (price
 *   snapshot) and fee + price must equal the total, so a mangled note can't
 *   record a wrong split — a mismatch returns null (caller rejects).
 * - otherwise (orders created before the deploy): legacy deducted fee —
 *   amount = booking price, split with today's rate, exactly as before.
 *
 * @param {object} booking with service + bookingVehicle
 * @param {object|null|undefined} notes Razorpay order notes
 * @returns {Promise<{amount:number, platformFee:number, vendorAmount:number, feeModel:string|null}|null>}
 */
export async function resolveExpectedCharge(booking, notes) {
  const price = resolveBookingAmount(booking);

  if (notes?.feeModel === FEE_MODEL_ON_TOP) {
    const pricePaise = Math.round(Number(notes.servicePrice) * 100);
    const feePaise = Math.round(Number(notes.platformFee) * 100);
    if (!Number.isFinite(pricePaise) || !Number.isFinite(feePaise) || feePaise < 0) return null;
    if (pricePaise !== Math.round(price * 100)) return null;
    return {
      amount: (pricePaise + feePaise) / 100,
      platformFee: feePaise / 100,
      vendorAmount: pricePaise / 100,
      feeModel: FEE_MODEL_ON_TOP,
    };
  }

  const { platformFee, vendorAmount } = computeSplit(price, await resolvePlatformFeeRate());
  return { amount: price, platformFee, vendorAmount, feeModel: null };
}

