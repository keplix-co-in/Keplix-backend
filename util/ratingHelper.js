// Incrementally updates a vendor's cached average rating instead of
// re-aggregating the full review table on every review write.
// Must be called with a transaction client (tx) so the review create and
// the rating update commit atomically.
export const applyReviewToVendorRating = async (tx, vendorId, newRating) => {
  const vendorProfile = await tx.vendorProfile.findUnique({
    where: { userId: vendorId },
    select: { rating: true, numReviews: true },
  });

  if (!vendorProfile) return;

  const oldCount = vendorProfile.numReviews;
  const oldAvg = vendorProfile.rating;
  const newCount = oldCount + 1;
  const newAvg = (oldAvg * oldCount + newRating) / newCount;

  await tx.vendorProfile.update({
    where: { userId: vendorId },
    data: { rating: newAvg, numReviews: newCount },
  });
};

// Inverse of applyReviewToVendorRating — call when a review is deleted.
export const removeReviewFromVendorRating = async (tx, vendorId, removedRating) => {
  const vendorProfile = await tx.vendorProfile.findUnique({
    where: { userId: vendorId },
    select: { rating: true, numReviews: true },
  });

  if (!vendorProfile || vendorProfile.numReviews <= 0) return;

  const oldCount = vendorProfile.numReviews;
  const oldAvg = vendorProfile.rating;
  const newCount = oldCount - 1;
  const newAvg = newCount > 0 ? (oldAvg * oldCount - removedRating) / newCount : 0;

  await tx.vendorProfile.update({
    where: { userId: vendorId },
    data: { rating: newAvg, numReviews: newCount },
  });
};
