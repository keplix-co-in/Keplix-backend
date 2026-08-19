-- Backfills category on the 5 existing components, and seeds the checklist
-- items for the other 4 workshop categories from the product spec (§3).
--
-- The new rows are seeded is_active = FALSE. healthSheetController.js requires
-- EVERY active component on a component-based sheet — if these were active,
-- every existing (mechanical) booking flow would suddenly demand Panel
-- Repaired / Tread Depth / etc. on a form that has no field for them. They
-- stay inactive, and therefore invisible, until the category-adaptive
-- rendering work explicitly turns each set on together with the UI that reads
-- HealthComponent.category to pick the right set per booking.
UPDATE "HealthComponent" SET "category" = 'MECHANICAL'
  WHERE "key" IN ('engine_oil', 'brakes', 'battery', 'tyres', 'ac_filter');

INSERT INTO "HealthComponent" ("key", "label", "display_order", "is_active", "category") VALUES
  -- 3.2 Car Wash & Detailing
  ('wash_exterior_foam', 'Exterior Foam Wash & Dry', 1, false, 'WASH'),
  ('wash_interior_vacuum', 'Interior Vacuuming', 2, false, 'WASH'),
  ('wash_dashboard', 'Dashboard Dressing', 3, false, 'WASH'),
  ('wash_underbody', 'Underbody Wash', 4, false, 'WASH'),

  -- 3.3 Denting & Painting
  ('panel_repaired', 'Panel Repaired', 1, false, 'DENTING_PAINTING'),
  ('repair_type', 'Repair Type', 2, false, 'DENTING_PAINTING'),
  ('paint_warranty', 'Paint Warranty', 3, false, 'DENTING_PAINTING'),

  -- 3.4 Tyre & Wheel Alignment
  ('tread_depth', 'Tread Depth Life %', 1, false, 'TYRES'),
  ('alignment_report', 'Alignment Report', 2, false, 'TYRES'),
  ('tyre_pressure', 'Pressure Check', 3, false, 'TYRES'),

  -- 3.5 Insurance
  ('insurer_name', 'Insurer Name', 1, false, 'INSURANCE'),
  ('policy_number', 'Policy Number', 2, false, 'INSURANCE'),
  ('policy_expiry', 'Expiry Date', 3, false, 'INSURANCE'),
  ('policy_type', 'Policy Type', 4, false, 'INSURANCE')
ON CONFLICT ("key") DO NOTHING;
