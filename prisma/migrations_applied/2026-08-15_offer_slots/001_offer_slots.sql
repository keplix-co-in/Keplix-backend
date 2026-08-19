-- Admin-managed offer placement slots.
--
-- Additive and idempotent: two new tables and a seed guarded by ON CONFLICT.
-- No existing table or column is touched.

CREATE TABLE IF NOT EXISTS "OfferSlot" (
  "id"             SERIAL PRIMARY KEY,
  "key"            TEXT NOT NULL,
  "label"          TEXT NOT NULL,
  "description"    TEXT,
  "headline"       TEXT,
  "body"           TEXT,
  "badge_text"     TEXT,
  "image_url"      TEXT,
  "discount_type"  TEXT,
  "discount_value" DECIMAL(10,2),
  "is_active"      BOOLEAN NOT NULL DEFAULT false,
  "starts_at"      TIMESTAMP(3),
  "ends_at"        TIMESTAMP(3),
  "display_order"  INTEGER NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "OfferSlot_key_key" ON "OfferSlot" ("key");
CREATE INDEX IF NOT EXISTS "OfferSlot_is_active_idx" ON "OfferSlot" ("is_active");

-- Vendor targeting. An EMPTY target set means "all vendors"; rows restrict the
-- slot to those vendors only.
CREATE TABLE IF NOT EXISTS "OfferSlotVendor" (
  "id"          SERIAL PRIMARY KEY,
  "offerSlotId" INTEGER NOT NULL,
  "vendorId"    INTEGER NOT NULL,
  CONSTRAINT "OfferSlotVendor_offerSlotId_fkey"
    FOREIGN KEY ("offerSlotId") REFERENCES "OfferSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OfferSlotVendor_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "OfferSlotVendor_offerSlotId_vendorId_key"
  ON "OfferSlotVendor" ("offerSlotId", "vendorId");
CREATE INDEX IF NOT EXISTS "OfferSlotVendor_vendorId_idx"
  ON "OfferSlotVendor" ("vendorId");

-- Seed the three slots that replace existing hardcoded strings, using the EXACT
-- current copy and is_active = true. The apps must look identical the moment
-- this ships — the only difference is that the text becomes editable.
INSERT INTO "OfferSlot"
  ("key", "label", "description", "headline", "body", "badge_text", "is_active", "display_order", "updatedAt")
VALUES
  ('home_banner_1',
   'Homepage banner (first slide)',
   'Large promo banner at the top of the customer home screen, first slide.',
   '15%', 'Discount on your first service booking', NULL, true, 1, CURRENT_TIMESTAMP),

  ('home_banner_2',
   'Homepage banner (second slide)',
   'Large promo banner at the top of the customer home screen, second slide.',
   '24/7', 'Roadside assistance whenever you need it', NULL, true, 2, CURRENT_TIMESTAMP),

  ('workshop_card_badge',
   'Workshop card badge',
   'Red tag on workshop cards, shown on the home screen and the garages list.',
   NULL, NULL, 'Flat ₹100 off', true, 3, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
