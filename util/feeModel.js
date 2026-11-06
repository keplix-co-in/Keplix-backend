/**
 * Payment.feeModel value for fee-on-top payments. NULL = legacy (deducted).
 * Dependency-free on purpose: the refund modules need only this and
 * refundableBase, and must not pull in the settings/pricing modules.
 */
export const FEE_MODEL_ON_TOP = 'on_top';

/**
 * The part of a payment the customer can ever get back.
 *
 * On-top payments: Keplix keeps its fee on refund (owner decision
 * 2026-11-06), so only amount − platformFee is refundable. platformFee is
 * never rewritten for on-top payments (see recomputeSplitAfterRefunds), so
 * this stays stable across partial refunds. Legacy payments: the full amount.
 *
 * @param {{amount:any, platformFee?:any, feeModel?:string|null}} payment
 * @returns {number} rupees
 */
export function refundableBase(payment) {
  const amountPaise = Math.round(parseFloat(payment.amount?.toString() || '0') * 100);
  if (payment.feeModel !== FEE_MODEL_ON_TOP) return amountPaise / 100;
  const feePaise = Math.round(parseFloat(payment.platformFee?.toString() || '0') * 100);
  return Math.max(0, amountPaise - feePaise) / 100;
}
