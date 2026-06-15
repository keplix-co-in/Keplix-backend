/**
 * Utility to update vendor rating and review count incrementally.
 * Should be called within a Prisma transaction.
 * 
 * @param {object} tx - Prisma transaction client
 * @param {number} vendorId - ID of the vendor (User ID)
 * @param {number} ratingValue - The rating value of the new or deleted review
 * @param {boolean} isDeletion - Whether this is a deletion operation
 */
export const updateVendorRatingStats = async (tx, vendorId, ratingValue, isDeletion = false) => {
  if (!vendorId) return;

  const vendorProfile = await tx.vendorProfile.findUnique({
    where: { userId: vendorId },
    select: { rating: true, numReviews: true }
  });

  if (!vendorProfile) return;

  const currentCount = vendorProfile.numReviews || 0;
  const currentAvg = vendorProfile.rating || 0;

  let newCount, newAvg;

  if (isDeletion) {
    if (currentCount <= 0) return; // Should not happen
    newCount = currentCount - 1;
    if (newCount === 0) {
      newAvg = 0;
    } else {
      // Formula: (TotalSum - DeletedRating) / NewCount
      newAvg = ((currentAvg * currentCount) - ratingValue) / newCount;
    }
  } else {
    newCount = currentCount + 1;
    // Formula: (TotalSum + NewRating) / NewCount
    newAvg = ((currentAvg * currentCount) + ratingValue) / newCount;
  }

  await tx.vendorProfile.update({
    where: { userId: vendorId },
    data: {
      rating: Math.max(0, newAvg),
      numReviews: newCount
    }
  });
};
