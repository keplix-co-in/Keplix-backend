# Review replies + vendor-scoped review listing — 2026-08-14

**Status: NOT YET APPLIED.** Run `001_review_reply.sql` against `DATABASE_URL`
before deploying the code that depends on it.

    npx prisma db execute --file prisma/migrations_applied/2026-08-14_review_reply_and_vendor_index/001_review_reply.sql --schema prisma/schema.prisma

## What it does

1. Adds `Review.repliedAt` (nullable `TIMESTAMP(3)`).
2. Backfills `Review.vendorId` from `Booking -> Service.vendorId` where NULL.
3. Adds the composite index `Review_vendorId_createdAt_idx`.

All three are additive and idempotent (`IF NOT EXISTS` / `WHERE vendorId IS NULL`),
so re-running is safe.

## Ordering constraint

Step 2 is **not optional** and must land before or with the new vendor reviews
endpoint. `GET /interactions/api/vendor/reviews` filters on `Review.vendorId`
so the query can use an index rather than joining through `booking -> service`.
`Review.vendorId` is nullable and was only populated by `createReview` /
`bookingConfirmationService`, so any review predating that would be invisible to
the vendor it belongs to until this backfill runs.

If you deploy the code first, the symptom is an incomplete (possibly empty)
review list rather than an error — quiet, so verify the backfill rather than
assuming.

## Verification

    -- expect 0
    SELECT COUNT(*) FROM "Review" r
    JOIN "Booking" b ON b."id" = r."bookingId"
    WHERE r."vendorId" IS NULL;

    -- expect vendorId to match the service owner for every row
    SELECT COUNT(*) FROM "Review" r
    JOIN "Booking" b ON b."id" = r."bookingId"
    JOIN "Service" s ON s."id" = b."serviceId"
    WHERE r."vendorId" IS DISTINCT FROM s."vendorId";

## Related, deliberately not done here

`Review.rating` stays `Int`. The API validator now enforces an integer and
`createReview` rounds, rather than widening the column to `Float` — half-star
ratings were never storable, so no existing data needs to change. If half stars
become a product requirement, that is a separate column-type migration plus a
decision about what the existing whole-number history means.
