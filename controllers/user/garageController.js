import prisma from '../../util/prisma.js';
import Logger from '../../util/logger.js';
import { generateOTP } from '../../util/otp.js';
import { sendSMS } from '../../util/communication.js';

/** Per-phone throttle on top of the per-IP rate limiter (claimRequestLimiter)
 * — that limiter alone doesn't stop someone spraying many different numbers
 * from one IP. A fresh OTP row within this window means a request for the
 * same number very recently. */
const PHONE_REQUEST_COOLDOWN_MS = 2 * 60 * 1000;

// @desc    List the current user's saved vehicles
// @route   GET /service_api/user/garage/vehicles
export const listVehicles = async (req, res) => {
  try {
    const vehicles = await prisma.vehicle.findMany({
      where: { ownerUserId: req.user.id },
      orderBy: { updatedAt: 'desc' },
      include: {
        // Booking carries no vehicleId (see prisma/schema.prisma — Booking is
        // untouched by this feature), so only walk-in jobs can be attributed
        // to a specific vehicle here. A user's in-app Bookings still show up
        // in /garage/history, just not nested under a vehicle card.
        walkInJobs: {
          where: { claimedByUserId: req.user.id },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { createdAt: true, status: true },
        },
      },
    });

    const data = vehicles.map((v) => ({
      id: v.id,
      registration: v.registration,
      make: v.make,
      model: v.model,
      year: v.year,
      odometer_km: v.odometer_km,
      last_service_at: v.walkInJobs[0]?.createdAt ?? null,
    }));

    return res.json({ data });
  } catch (error) {
    Logger.error(`[Garage] listVehicles failed: ${error.message}`);
    return res.status(500).json({ message: 'Server Error' });
  }
};

// @desc    One vehicle's own walk-in job timeline
// @route   GET /service_api/user/garage/vehicles/:id
export const getVehicle = async (req, res) => {
  try {
    const vehicle = await prisma.vehicle.findFirst({
      where: { id: parseInt(req.params.id), ownerUserId: req.user.id },
      include: {
        walkInJobs: {
          where: { claimedByUserId: req.user.id },
          orderBy: { createdAt: 'desc' },
          include: { healthSheet: { select: { id: true, submitted_at: true } } },
        },
      },
    });
    if (!vehicle) return res.status(404).json({ message: 'Vehicle not found' });
    return res.json({ vehicle });
  } catch (error) {
    Logger.error(`[Garage] getVehicle failed: ${error.message}`);
    return res.status(500).json({ message: 'Server Error' });
  }
};

// @desc    Service history: the user's own Bookings, merged with WalkInJobs
//          they've claimed, newest first.
// @route   GET /service_api/user/garage/history
export const getHistory = async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const pageNum = Number(page);
  const limitNum = Number(limit);

  try {
    // Two queries + an in-memory merge, not a raw UNION ALL — this project
    // has no raw-SQL precedent in its controllers, and history volume per
    // user is small. Over-fetch page*limit from each side so the merged,
    // sorted slice for this page is never short a real entry.
    const take = pageNum * limitNum;

    const [bookings, walkIns] = await Promise.all([
      prisma.booking.findMany({
        where: { userId: req.user.id },
        orderBy: { booking_date: 'desc' },
        take,
        include: {
          service: { select: { name: true, vendor: { select: { vendorProfile: { select: { business_name: true } } } } } },
          // Needed so the app can link straight to the health sheet from a
          // history row — without this the id was never in the response and
          // tapping an item with a sheet had nothing to navigate to.
          healthSheet: { select: { id: true } },
        },
      }),
      prisma.walkInJob.findMany({
        where: { claimedByUserId: req.user.id },
        orderBy: { createdAt: 'desc' },
        take,
        include: {
          vehicle: true,
          vendor: { select: { vendorProfile: { select: { business_name: true } } } },
          healthSheet: { select: { id: true } },
        },
      }),
    ]);

    const merged = [
      ...bookings.map((b) => ({
        type: 'booking',
        id: b.id,
        date: b.booking_date,
        status: b.status,
        service_name: b.service?.name,
        garage_name: b.service?.vendor?.vendorProfile?.business_name,
        health_sheet_id: b.healthSheet?.id ?? null,
      })),
      ...walkIns.map((w) => ({
        type: 'walk_in',
        id: w.id,
        date: w.createdAt,
        status: w.status,
        description: w.description,
        vehicle: w.vehicle ? { registration: w.vehicle.registration, model: w.vehicle.model } : null,
        garage_name: w.vendor?.vendorProfile?.business_name,
        health_sheet_id: w.healthSheet?.id ?? null,
      })),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const start = (pageNum - 1) * limitNum;
    const data = merged.slice(start, start + limitNum);

    return res.json({ data, page: pageNum, limit: limitNum });
  } catch (error) {
    Logger.error(`[Garage] getHistory failed: ${error.message}`);
    return res.status(500).json({ message: 'Server Error' });
  }
};

// @desc    One health sheet, ownership-checked via its parent Booking or
//          claimed WalkInJob.
// @route   GET /service_api/user/garage/health-sheets/:id
export const getHealthSheetForUser = async (req, res) => {
  try {
    const sheet = await prisma.healthSheet.findFirst({
      where: {
        id: parseInt(req.params.id),
        OR: [
          { booking: { userId: req.user.id } },
          { walkInJob: { claimedByUserId: req.user.id } },
        ],
      },
      include: { items: { include: { component: true } } },
    });
    if (!sheet) return res.status(404).json({ message: 'Health sheet not found' });
    return res.json({ healthSheet: sheet });
  } catch (error) {
    Logger.error(`[Garage] getHealthSheetForUser failed: ${error.message}`);
    return res.status(500).json({ message: 'Server Error' });
  }
};

// @desc    Request an OTP to claim any walk-in history recorded against a
//          phone number.
// @route   POST /service_api/user/garage/claim/request
export const claimRequest = async (req, res) => {
  const { phone } = req.body;

  // Always the same response, whatever happens below — this endpoint must
  // never let a caller learn "does phone X have service history at Keplix"
  // by watching for a different response shape. Errors are logged, not
  // surfaced.
  const genericResponse = { success: true, message: 'If eligible, a verification code has been sent.' };

  try {
    const recent = await prisma.phoneOTP.findUnique({ where: { phone_number: phone } });
    if (recent && Date.now() - recent.createdAt.getTime() < PHONE_REQUEST_COOLDOWN_MS) {
      // Still generic — a cooldown response and a success response must look
      // the same from the outside, or the timing itself becomes a signal.
      return res.json(genericResponse);
    }

    const otp = generateOTP();
    await prisma.phoneOTP.upsert({
      where: { phone_number: phone },
      update: { otp, expiresAt: new Date(Date.now() + 10 * 60 * 1000), verified: false },
      create: { phone_number: phone, otp, expiresAt: new Date(Date.now() + 10 * 60 * 1000), verified: false },
    });

    await sendSMS(phone, `Your Keplix My Garage verification code is: ${otp}. Valid for 10 minutes.`);
  } catch (error) {
    Logger.error(`[Garage] claimRequest failed: ${error.message}`);
  }

  return res.json(genericResponse);
};

// @desc    Verify the OTP and claim any WalkInJob/Vehicle rows recorded
//          against that phone number.
// @route   POST /service_api/user/garage/claim/verify
export const claimVerify = async (req, res) => {
  const { phone, otp } = req.body;
  const userId = req.user.id;

  try {
    const record = await prisma.phoneOTP.findUnique({ where: { phone_number: phone } });
    if (!record) return res.status(400).json({ message: 'Request a code first.' });
    if (new Date() > record.expiresAt) return res.status(400).json({ message: 'Code has expired.' });
    if (record.otp !== otp) return res.status(400).json({ message: 'Incorrect code.' });

    const existingIdentity = await prisma.phoneIdentity.findUnique({ where: { phone_e164: phone } });
    if (existingIdentity && existingIdentity.userId && existingIdentity.userId !== userId) {
      // Someone else already verified and claimed this number — the first
      // verified claimant wins. A recycled-SIM dispute goes through admin,
      // not a second automatic claim.
      return res.status(409).json({ message: 'This number is already linked to another account.' });
    }

    const [, jobs, vehicles] = await prisma.$transaction([
      prisma.phoneOTP.update({ where: { phone_number: phone }, data: { verified: true } }),
      prisma.walkInJob.updateMany({
        where: { customer_phone: phone, claimedByUserId: null },
        data: { claimedByUserId: userId },
      }),
      prisma.vehicle.updateMany({
        where: { owner_phone: phone, ownerUserId: null },
        data: { ownerUserId: userId },
      }),
    ]);

    await prisma.phoneIdentity.upsert({
      where: { phone_e164: phone },
      update: { userId, verified_at: new Date() },
      create: { phone_e164: phone, userId, verified_at: new Date() },
    });

    return res.json({ claimed: { jobs: jobs.count, vehicles: vehicles.count } });
  } catch (error) {
    Logger.error(`[Garage] claimVerify failed: ${error.message}`);
    return res.status(500).json({ message: 'Server Error' });
  }
};
