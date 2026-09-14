import prisma from "../util/prisma.js";

/**
 * getUserDataExport
 *
 * GDPR Art.15/Art.20 access and portability, for a single account. Shared
 * by both profile route families this backend carries
 * (routes/user/profile.js's :userId-scoped routes, and routes/auth.js's
 * req.user.id-scoped /accounts/auth/* routes) so the actual query logic
 * exists in exactly one place.
 *
 * @param {number} userId
 * @returns {Promise<object|null>} null if the user does not exist.
 */
export const getUserDataExport = async (userId) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      role: true,
      is_active: true,
      is_verified: true,
      createdAt: true,
      userProfile: true,
    },
  });

  if (!user) return null;

  const bookings = await prisma.booking.findMany({
    where: { userId },
    include: { service: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
  const bookingIds = bookings.map((b) => b.id);

  const [
    payments,
    bookingVehicles,
    healthSheets,
    reviews,
    messages,
    notifications,
    feedback,
    vehicles,
    walkInJobs,
    phoneIdentity,
  ] = await Promise.all([
    prisma.payment.findMany({
      where: { bookingId: { in: bookingIds } },
      // Redacted per the audit's fix: internal payout/gateway-fee
      // bookkeeping fields excluded, not something a customer needs in
      // their own export.
      select: {
        id: true, bookingId: true, amount: true, currency: true,
        status: true, method: true, createdAt: true,
      },
    }),
    prisma.bookingVehicle.findMany({ where: { bookingId: { in: bookingIds } } }),
    prisma.healthSheet.findMany({ where: { bookingId: { in: bookingIds } } }),
    prisma.review.findMany({ where: { userId } }),
    prisma.message.findMany({ where: { senderId: userId }, orderBy: { sent_at: "desc" } }),
    prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }),
    prisma.feedback.findMany({ where: { userId } }),
    prisma.vehicle.findMany({ where: { ownerUserId: userId } }),
    prisma.walkInJob.findMany({ where: { claimedByUserId: userId } }),
    prisma.phoneIdentity.findUnique({ where: { userId } }),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    account: user,
    phoneIdentity,
    bookings,
    payments,
    bookingVehicles,
    healthSheets,
    reviews,
    messages,
    notifications,
    feedback,
    vehicles,
    walkInJobs,
  };
};
