-- Seeds the 5 inspection components from the product spec. ON CONFLICT makes
-- this safe to re-run.
INSERT INTO "HealthComponent" ("key", "label", "display_order", "is_active") VALUES
  ('engine_oil', 'Engine Oil & Filters',    1, true),
  ('brakes',     'Brakes & Brake Pads',     2, true),
  ('battery',    'Battery & Electricals',   3, true),
  ('tyres',      'Tyres & Suspension',      4, true),
  ('ac_filter',  'AC & Cabin Filter',       5, true)
ON CONFLICT ("key") DO NOTHING;
