import prisma from '../../util/prisma.js';
import Logger from '../../util/logger.js';
import { generatePublicToken } from '../../util/publicToken.js';
import { normalizeRegistration } from '../../util/vehicle.js';
import { addNotificationJob } from '../../queues/notificationQueue.js';
import { assertHealthSheetPresent } from '../../services/healthSheetService.js';

// @desc    Create a walk-in job (offline customer, no Booking/User/Service row)
// @route   POST /service_api/vendor/walk-in-jobs
export const createWalkInJob = async (req, res) => {
  const { customer_name, customer_phone, vehicle, description, amount_collected, payment_mode } = req.body;
  const vendorId = req.user.id;
  // Normalised again here, not just trusted from the Zod schema — see
  // util/vehicle.js for why.
  const registration = normalizeRegistration(vehicle.registration);

  try {
    // Already claimed by a signed-up user? Land the job in their garage
    // immediately rather than waiting for a future claim pass.
    const phoneIdentity = await prisma.phoneIdentity.findUnique({
      where: { phone_e164: customer_phone },
      select: { userId: true },
    });

    const { job, vehicleRow } = await prisma.$transaction(async (tx) => {
      const vehicleRow = await tx.vehicle.upsert({
        where: {
          vehicle_reg_per_vendor: { registration, createdByVendorId: vendorId },
        },
        update: {
          // A revisit can update details (odometer moves on, model gets
          // corrected) without creating a duplicate row for the same plate
          // at the same garage.
          make: vehicle.make ?? undefined,
          model: vehicle.model ?? undefined,
          year: vehicle.year ?? undefined,
          fuel_type: vehicle.fuel_type ?? undefined,
          odometer_km: vehicle.odometer_km ?? undefined,
          owner_phone: customer_phone,
          owner_name: customer_name,
          ownerUserId: phoneIdentity?.userId ?? undefined,
        },
        create: {
          registration,
          make: vehicle.make,
          model: vehicle.model,
          year: vehicle.year,
          fuel_type: vehicle.fuel_type,
          odometer_km: vehicle.odometer_km,
          owner_phone: customer_phone,
          owner_name: customer_name,
          ownerUserId: phoneIdentity?.userId ?? null,
          createdByVendorId: vendorId,
        },
      });

      const job = await tx.walkInJob.create({
        data: {
          vendorId,
          vehicleId: vehicleRow.id,
          customer_name,
          customer_phone,
          claimedByUserId: phoneIdentity?.userId ?? null,
          description,
          amount_collected,
          payment_mode,
          public_token: generatePublicToken(),
        },
      });

      return { job, vehicleRow };
    });

    // Notification is deliberately OUTSIDE the transaction and its failure
    // must never fail job creation — the garage needs the job recorded even
    // if Redis/Twilio are down. Fire-and-forget: any rejection (including the
    // queue itself being unreachable) is caught and logged, not surfaced.
    const vendorProfile = await prisma.vendorProfile.findUnique({
      where: { userId: vendorId },
      select: { business_name: true },
    });

    addNotificationJob({
      type: 'WALK_IN_JOB_SHEET',
      walkInJobId: job.id,
      customerName: job.customer_name,
      customerPhone: job.customer_phone,
      vendorName: vendorProfile?.business_name || 'your garage',
      token: job.public_token,
    }).catch((err) => {
      Logger.error(`[WalkInJob] Failed to enqueue notification for job ${job.id}: ${err.message}`);
    });

    return res.status(201).json({ job, vehicle: vehicleRow });
  } catch (error) {
    Logger.error(`[WalkInJob] createWalkInJob failed: ${error.message}`);
    return res.status(500).json({ message: 'Server Error' });
  }
};

// @desc    List the vendor's own walk-in jobs
// @route   GET /service_api/vendor/walk-in-jobs
export const listWalkInJobs = async (req, res) => {
  const vendorId = req.user.id;
  const { status, phone, registration, page = 1, limit = 50 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  try {
    const where = {
      vendorId,
      ...(status ? { status } : {}),
      ...(phone ? { customer_phone: { contains: phone } } : {}),
      ...(registration
        ? { vehicle: { registration: { contains: normalizeRegistration(String(registration)) } } }
        : {}),
    };

    const [data, total] = await Promise.all([
      prisma.walkInJob.findMany({
        where,
        include: { vehicle: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take: Number(limit),
      }),
      prisma.walkInJob.count({ where }),
    ]);

    return res.json({ data, page: Number(page), limit: Number(limit), total });
  } catch (error) {
    Logger.error(`[WalkInJob] listWalkInJobs failed: ${error.message}`);
    return res.status(500).json({ message: 'Server Error' });
  }
};

// @desc    Get one of the vendor's own walk-in jobs
// @route   GET /service_api/vendor/walk-in-jobs/:id
export const getWalkInJob = async (req, res) => {
  const vendorId = req.user.id;

  try {
    const job = await prisma.walkInJob.findFirst({
      where: { id: parseInt(req.params.id), vendorId },
      include: { vehicle: true, healthSheet: { include: { items: { include: { component: true } } } } },
    });

    if (!job) return res.status(404).json({ message: 'Walk-in job not found' });
    return res.json({ job });
  } catch (error) {
    Logger.error(`[WalkInJob] getWalkInJob failed: ${error.message}`);
    return res.status(500).json({ message: 'Server Error' });
  }
};

// @desc    Update mutable fields on a walk-in job (not status)
// @route   PATCH /service_api/vendor/walk-in-jobs/:id
export const updateWalkInJob = async (req, res) => {
  const vendorId = req.user.id;

  try {
    const existing = await prisma.walkInJob.findFirst({
      where: { id: parseInt(req.params.id), vendorId },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ message: 'Walk-in job not found' });

    const job = await prisma.walkInJob.update({
      where: { id: existing.id },
      data: req.body,
    });
    return res.json({ job });
  } catch (error) {
    Logger.error(`[WalkInJob] updateWalkInJob failed: ${error.message}`);
    return res.status(500).json({ message: 'Server Error' });
  }
};

// @desc    Transition a walk-in job's status
// @route   PATCH /service_api/vendor/walk-in-jobs/:id/status
export const updateWalkInJobStatus = async (req, res) => {
  const vendorId = req.user.id;
  const { status } = req.body;

  try {
    const job = await prisma.walkInJob.findFirst({
      where: { id: parseInt(req.params.id), vendorId },
    });
    if (!job) return res.status(404).json({ message: 'Walk-in job not found' });

    if (status === 'completed') {
      // Same gate, same rollout rules as booking completion — see
      // services/healthSheetService.js and PlatformSettings in schema.prisma.
      const gate = await assertHealthSheetPresent({ createdAt: job.createdAt, walkInJobId: job.id });
      if (!gate.ok) return res.status(409).json({ code: gate.code, message: gate.message });
    }

    const updated = await prisma.walkInJob.update({
      where: { id: job.id },
      data: {
        status,
        started_at: status === 'in_progress' && !job.started_at ? new Date() : undefined,
        completed_at: status === 'completed' ? new Date() : undefined,
      },
    });

    return res.json({ job: updated });
  } catch (error) {
    Logger.error(`[WalkInJob] updateWalkInJobStatus failed: ${error.message}`);
    return res.status(500).json({ message: 'Server Error' });
  }
};

// @desc    Manually resend the tracking-link notification
// @route   POST /service_api/vendor/walk-in-jobs/:id/notify
export const resendWalkInJobNotification = async (req, res) => {
  const vendorId = req.user.id;

  try {
    const job = await prisma.walkInJob.findFirst({
      where: { id: parseInt(req.params.id), vendorId },
    });
    if (!job) return res.status(404).json({ message: 'Walk-in job not found' });

    const vendorProfile = await prisma.vendorProfile.findUnique({
      where: { userId: vendorId },
      select: { business_name: true },
    });

    await addNotificationJob({
      type: 'WALK_IN_JOB_SHEET',
      walkInJobId: job.id,
      customerName: job.customer_name,
      customerPhone: job.customer_phone,
      vendorName: vendorProfile?.business_name || 'your garage',
      token: job.public_token,
    });

    return res.json({ queued: true });
  } catch (error) {
    Logger.error(`[WalkInJob] resendWalkInJobNotification failed: ${error.message}`);
    return res.status(500).json({ message: 'Server Error' });
  }
};
