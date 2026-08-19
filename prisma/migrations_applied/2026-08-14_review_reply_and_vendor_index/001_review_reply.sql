-- Vendor review replies + vendor-scoped listing support.
--
-- All three statements are additive and idempotent. No existing column is
-- altered or dropped, and no row is deleted.

-- 1. repliedAt: written by the vendor reply controller since it was first
--    added, but never present on the model, so every reply threw
--    "Unknown arg `repliedAt`". Nullable with no default — existing rows are
--    correctly "never replied to".
ALTER TABLE "Review" ADD COLUMN IF NOT EXISTS "repliedAt" TIMESTAMP(3);

-- 2. Backfill Review.vendorId from the booking's service.
--
--    REQUIRED before the vendor reviews endpoint goes live. That endpoint
--    filters on Review.vendorId so the query can use an index instead of
--    joining through booking -> service. Any legacy row left with a NULL
--    vendorId would simply be invisible to the vendor it belongs to.
--
--    Scoped to NULL rows only, so it cannot overwrite a correct value.
UPDATE "Review" r
SET "vendorId" = s."vendorId"
FROM "Booking" b
JOIN "Service" s ON s."id" = b."serviceId"
WHERE r."bookingId" = b."id"
  AND r."vendorId" IS NULL;

-- 3. The vendor list is always (this vendor, newest first, paginated). On
--    the existing [vendorId] index alone Postgres still sorts every one of a
--    vendor's reviews to serve page 1.
CREATE INDEX IF NOT EXISTS "Review_vendorId_createdAt_idx"
  ON "Review" ("vendorId", "createdAt");

-- 4. Backfill VendorProfile.rating / numReviews from the reviews that exist.
--
--    These are denormalised counters written ONLY when a review is created or
--    deleted (util/ratingHelper.js). They were never populated for reviews
--    that already existed, so every such vendor reads 0.0 — which is why the
--    vendor app showed no rating even with reviews on file. Anything else
--    reading VendorProfile.rating (customer-facing vendor lists, sorting by
--    rating) was showing the same 0.
--
--    MUST run after step 2: it groups by Review.vendorId, so rows still
--    holding a NULL vendorId would be excluded from their vendor's average.
UPDATE "VendorProfile" vp
SET "rating" = COALESCE(agg."avg_rating", 0),
    "numReviews" = COALESCE(agg."review_count", 0)
FROM (
  SELECT "vendorId", AVG("rating")::double precision AS "avg_rating",
         COUNT(*)::integer AS "review_count"
  FROM "Review"
  WHERE "vendorId" IS NOT NULL
  GROUP BY "vendorId"
) agg
WHERE vp."userId" = agg."vendorId";
