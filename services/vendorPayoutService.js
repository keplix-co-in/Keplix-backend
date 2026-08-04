import prisma from "../util/prisma.js";
import { initiateVendorPayout } from "../util/payoutHelper.js";

/**
 * Thrown by service functions to carry an intended HTTP status code, so the
 * controller can map it to a response without the service layer knowing
 * anything about Express.
 */
export class VendorPayoutError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'VendorPayoutError';
    this.statusCode = statusCode;
  }
}

/**
 * Synchronously triggers a vendor payout via the gateway (as opposed to
 * services/payoutService.js's claimAndQueuePayout, which defers the gateway
 * call to the async BullMQ worker). Used by the admin-triggered
 * /service_api/admin/vendor/payout endpoint, which requires the vendor to
 * already have an active VendorPayoutAccount.
 *
 * @param {number} paymentId
 * @returns {Promise<{ payoutId: string, amount: import('@prisma/client').Prisma.Decimal }>}
 * @throws {VendorPayoutError} 400/404 on ineligible payment, 500 on gateway/transaction failure
 */
export const triggerVendorPayoutNow = async (paymentId) => {
  if (!paymentId) {
    throw new VendorPayoutError("paymentId is required", 400);
  }

  let payment;
  let vendorId;

  try {
    const txResult = await prisma.$transaction(async (tx) => {
      const p = await tx.payment.findUnique({
        where: { id: Number(paymentId) },
        include: {
          booking: {
            include: {
              service: true,
            },
          },
        },
      });

      if (!p) {
        return { error: "Payment not found", status: 404 };
      }

      if (p.status !== "success") {
        return { error: "Payment not successful", status: 400 };
      }

      if (p.vendorPayoutStatus !== "pending") {
        return { error: "Vendor payout already processed", status: 400 };
      }

      const vId = p.booking?.service?.vendorId;
      if (!vId) {
        return { error: "Vendor not found for booking", status: 400 };
      }

      const payoutAccount = await tx.vendorPayoutAccount.findUnique({
        where: { vendorId: vId },
      });

      if (!payoutAccount || !payoutAccount.isActive) {
        return { error: "Vendor payout account not found or inactive", status: 400 };
      }

      // Lock the row by marking it "processing" to prevent concurrent requests
      await tx.payment.update({
        where: { id: p.id },
        data: { vendorPayoutStatus: "processing" },
      });

      return { payment: p, vendorId: vId };
    });

    if (txResult.error) {
      throw new VendorPayoutError(txResult.error, txResult.status);
    }

    payment = txResult.payment;
    vendorId = txResult.vendorId;
  } catch (error) {
    if (error instanceof VendorPayoutError) throw error;
    console.error("Transaction error:", error);
    throw new VendorPayoutError(error.message || "Vendor payout failed", 500);
  }

  // Step 2: Initiate external payout (outside transaction to avoid long-held locks)
  const payoutResult = await initiateVendorPayout(payment, vendorId);

  if (!payoutResult.success) {
    // Rollback status to "pending" so it can be retried
    await prisma.payment.update({
      where: { id: payment.id },
      data: { vendorPayoutStatus: "pending" },
    });

    throw new VendorPayoutError(payoutResult.error || "Vendor payout failed", 500);
  }

  // Step 3: Mark payout as "paid" with the external payout ID
  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      vendorPayoutStatus: "paid",
      vendorPayoutId: payoutResult.payoutId,
    },
  });

  return { payoutId: payoutResult.payoutId, amount: payment.vendorAmount };
};
