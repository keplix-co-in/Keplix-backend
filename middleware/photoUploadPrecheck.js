/**
 * Cheap checks that run BEFORE the multipart/Cloudinary upload on
 * POST /vendor/bookings/:id/photos. uploadFieldss pushes files to Cloudinary
 * during parsing, so without this a vendor could burn storage/bandwidth on
 * bookings that are not theirs, not checked in, or full.
 * Error codes mirror services/pricingV2Service.js addPhotos. The service still
 * re-checks everything inside its transaction; this is only an early reject.
 * `kind` lives in the multipart body, which is not parsed yet, so the photo
 * limit is rejected only when NO kind could accept more photos.
 */
import prisma from '../util/prisma.js';
import { parseIdParam } from '../util/parseIdParam.js';
import { MAX_CHECK_IN_PHOTOS, MAX_REQUEST_PHOTOS } from '../services/pricingV2Service.js';

const fail = (res, status, code, message) => res.status(status).json({ success: false, message, code });

export const photoUploadPrecheck = async (req, res, next) => {
  const bookingId = parseIdParam(req.params.id);
  if (!bookingId) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid booking id');
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        service: { select: { vendorId: true } },
        bookingJob: { select: { id: true } },
        bookingPhotos: { select: { kind: true, extraWorkRequestId: true } },
        extraWorkRequests: { select: { id: true, status: true } },
      },
    });
    if (!booking) return fail(res, 404, 'NOT_FOUND', 'Booking not found');
    if (booking.service?.vendorId !== req.user.id) return fail(res, 403, 'FORBIDDEN', 'This booking is not yours');
    if (!booking.bookingJob) return fail(res, 409, 'NOT_CHECKED_IN', 'Check in before adding photos');

    const photos = booking.bookingPhotos ?? [];
    const checkInFull = photos.filter((p) => p.kind === 'check_in').length >= MAX_CHECK_IN_PHOTOS;
    const openRequestHasRoom = (booking.extraWorkRequests ?? []).some(
      (r) => ['pending', 'partially_approved'].includes(r.status)
        && photos.filter((p) => p.extraWorkRequestId === r.id).length < MAX_REQUEST_PHOTOS
    );
    if (checkInFull && !openRequestHasRoom) {
      return fail(res, 409, 'PHOTO_LIMIT', `At most ${MAX_CHECK_IN_PHOTOS} check-in photos per booking`);
    }
    return next();
  } catch (err) {
    return next(err);
  }
};
