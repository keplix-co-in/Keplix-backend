-- Refund policy + payout hold.
--
-- All additive and nullable/defaulted, so existing rows and in-flight payouts
-- are unaffected by the DDL alone. The behavioural switch is
-- "autoRefundOnCancellation", which defaults to FALSE on purpose: deploying
-- this migration must not start issuing refunds until the policy layer has
-- been verified in place.

-- Platform-wide refund/payout configuration. Read through
-- util/platformSettings.js, which falls back to DEFAULTS when the singleton
-- row is missing.
ALTER TABLE "PlatformSettings" ADD COLUMN IF NOT EXISTS "payoutHoldHours" INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "PlatformSettings" ADD COLUMN IF NOT EXISTS "autoRefundOnCancellation" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PlatformSettings" ADD COLUMN IF NOT EXISTS "refundGatewayFeeBorneBy" TEXT NOT NULL DEFAULT 'customer';

-- Escrow hold anchor. Deliberately on Payment and NOT on Booking: the schema
-- rule (see the BookingVehicle comment) is that Booking, the payment/escrow
-- critical model, must not be modified. Payment is already written by the
-- payout flow, so the hold lives with the money it holds back.
--
-- NULL means "no hold recorded" — the payout guard treats that as releasable,
-- so bookings completed before this migration are not retroactively frozen.
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "payoutHoldUntil" TIMESTAMP(3);

-- Gateway fee actually charged by Razorpay on the original payment, in rupees.
-- Only populated when a refund needs it (the fee is not knowable at capture
-- time from our side without an extra API call). NULL means "unknown", and the
-- refund policy deliberately refunds the FULL amount in that case rather than
-- guessing a deduction.
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "gatewayFee" DECIMAL(65,30);
