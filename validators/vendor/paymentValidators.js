import { z } from "zod";

/**
 * Vendor -> Keplix payments (subscription / ads), NOT customer bookings.
 *
 * Both routes previously had NO validator at all. `amount` was read straight from
 * the body with only a truthiness check, so a non-numeric value reached
 * `Math.round(amount * 100)` as NaN, and a negative value was passed to the
 * gateway unchallenged.
 *
 * KNOWN REMAINING GAP, deliberately not "fixed" here: the amount is still
 * client-supplied. The customer booking flow resolves the price server-side
 * (util/servicePricing.js resolveBookingAmount), but there is no equivalent
 * source of truth for vendor plans -- the price is hardcoded in the vendor app
 * (Payment4.jsx, "Pay Rs 10,499"). So a vendor can still create an order for less
 * than the intended price and pay that.
 *
 * What this validator does do is bound the damage to "a plausible-looking number":
 * no NaN, no negatives, no zero, no absurd values. The real fix is a plans/prices
 * table the server reads from, keyed by plan id rather than an amount -- that is a
 * product decision, not a validation one.
 *
 * The VERIFY side is already safe: it ignores the body amount and reads
 * `razorpay.orders.fetch(orderId).amount`, so recorded revenue cannot be faked.
 */
export const createVendorPaymentOrderSchema = z.object({
  amount: z
    .number({ invalid_type_error: "amount must be a number" })
    .positive("amount must be greater than zero")
    .max(500000, "amount exceeds the maximum permitted for a vendor payment"),
  currency: z.string().length(3).optional(),
  gateway: z.enum(["razorpay"]).optional(),
});

export const verifyVendorPaymentSchema = z.object({
  orderId: z.string().min(1, "orderId is required"),
  paymentId: z.string().min(1, "paymentId is required"),
  signature: z.string().min(1, "signature is required"),
  // Accepted for backwards compatibility with the app but IGNORED by the
  // controller, which uses the gateway's own figure.
  amount: z.number().optional(),
  currency: z.string().length(3).optional(),
  gateway: z.enum(["razorpay"]),
});
