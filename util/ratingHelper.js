/**
 * Recomputes a vendor's denormalised rating aggregates from the Review table.
 *
 * MUST be called inside a Prisma transaction, AFTER the Review row has been
 * created or deleted — it derives the new values from what Review actually
 * contains rather than adjusting the stored average in place.
 *
 * This replaces an incremental read-modify-write ((avg*n ± r)/n'). That version
 * had two defects this one does not:
 *
 *   1. Lost updates. Two reviews landing concurrently both read the same
 *      `rating`/`numReviews`, each added its own, and whichever wrote last
 *      discarded the other's contribution. Deriving from a COUNT/AVG over the
 *      rows themselves cannot lose a row that is committed in the same
 *      transaction.
 *   2. Float drift. Repeatedly multiplying the stored average back out and
 *      re-dividing accumulated error, so a vendor's rating slowly diverged
 *      from the truth with no way to notice or correct it.
 *
 * The cost is one extra aggregate query per review write. Review writes are
 * rare (one per completed booking, at most) and the aggregate is served by the
 * [vendorId] index, so this is the right trade.
 *
 * @param {object} tx - Prisma transaction client
 * @param {number} vendorId - Vendor's User id (Review.vendorId / Service.vendorId)
 */
export const updateVendorRatingStats = async (tx, vendorId) => {
  if (!vendorId) return;

  // Missing profile is a no-op, never a throw: this runs inside the booking
  // confirmation transaction, and throwing here would roll back the vendor's
  // payout claim along with the rating.
  const vendorProfile = await tx.vendorProfile.findUnique({
    where: { userId: vendorId },
    select: { userId: true },
  });

  if (!vendorProfile) return;

  const stats = await tx.review.aggregate({
    where: { vendorId },
    _avg: { rating: true },
    _count: { _all: true },
  });

  const numReviews = stats._count._all ?? 0;
  // _avg is null when there are no rows left (the last review was deleted).
  const average = numReviews > 0 ? stats._avg.rating ?? 0 : 0;

  await tx.vendorProfile.update({
    where: { userId: vendorId },
    data: {
      rating: Math.max(0, average),
      numReviews,
    },
  });
};
