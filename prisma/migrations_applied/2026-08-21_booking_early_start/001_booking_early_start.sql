-- Add BookingEarlyStart — 2026-08-21
--
-- DDL generated with:
--   npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- then narrowed to this one table and made idempotent with IF NOT EXISTS.
--
-- Purely additive: a new table plus its FK and indexes. `Booking` itself is
-- NOT altered (the relation field on Booking is virtual — the FK lives here),
-- so the payment/escrow-critical table is untouched. Re-runnable.

CREATE TABLE IF NOT EXISTS "BookingEarlyStart" (
    "id"             SERIAL       NOT NULL,
    "bookingId"      INTEGER      NOT NULL,
    "requested_time" TEXT         NOT NULL,
    "status"         TEXT         NOT NULL DEFAULT 'pending',
    "requestedById"  INTEGER,
    "note"           TEXT,
    "requested_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at"   TIMESTAMP(3),
    "started_at"     TIMESTAMP(3),

    CONSTRAINT "BookingEarlyStart_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BookingEarlyStart_bookingId_key" ON "BookingEarlyStart"("bookingId");
CREATE INDEX IF NOT EXISTS "BookingEarlyStart_status_idx" ON "BookingEarlyStart"("status");

DO $$
BEGIN
    ALTER TABLE "BookingEarlyStart"
        ADD CONSTRAINT "BookingEarlyStart_bookingId_fkey"
        FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
