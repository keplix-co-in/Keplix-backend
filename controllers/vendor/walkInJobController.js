import prisma from '../../util/prisma.js';
import Logger from '../../util/logger.js';
import { generatePublicToken } from '../../util/publicToken.js';
import { normalizeRegistration } from '../../util/vehicle.js';
import { addNotificationJob } from '../../queues/notificationQueue.js';
import { assertHealthSheetPresent } from '../../services/healthSheetService.js';

// @desc    Create a walk-in job (offline customer, no Booking/User/Service row)
// @route   POST /service_api/vendor/walk-in-jobs
export const createWalkInJob = async (req, res) => {
  const { customer_name, customer_phone, vehicle, description, services, amount_collected, payment_mode } = req.body;
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

    // Resolve catalogue services against THIS vendor before writing anything.
    // A client-supplied service_id is never trusted: an id belonging to another
    // vendor is dropped to a custom entry rather than silently linking a rival's
    // service, and name/price are re-read from the catalogue so a tampered or
    // merely stale client can't misprice the snapshot.
    const requested = Array.isArray(services) ? services : [];
    const catalogueIds = requested.map((s) => s.service_id).filter(Boolean);
    const catalogue = catalogueIds.length
      ? await prisma.service.findMany({
          where: { id: { in: catalogueIds }, vendorId },
          select: { id: true, name: true, price: true },
        })
      : [];
    const catalogueById = new Map(catalogue.map((s) => [s.id, s]));

    const serviceRows = requested.map((s) => {
      const owned = s.service_id ? catalogueById.get(s.service_id) : null;
      return {
        serviceId: owned ? owned.id : null,
        name: owned ? owned.name : s.name,
        price: owned ? owned.price : s.price ?? null,
      };
    });

    // Existing readers (My Garage, the public tracking page, the admin card,
    // WalkInProgress) all display `description`. Composing it from the selected
    // names keeps every one of them working unchanged now that the vendor picks
    // services instead of typing a description.
    const composedDescription =
      description || (serviceRows.length ? serviceRows.map((s) => s.name).join(', ') : undefined);

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
          description: composedDescription,
          amount_collected,
          payment_mode,
          public_token: generatePublicToken(),
          ...(serviceRows.length ? { services: { create: serviceRows } } : {}),
        },
        include: { services: true },
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
      // Comma-separated, matching the convention getVendorBookings already
      // uses ("ongoing,confirmed,accepted"). The vendor's Ongoing tab needs
      // open AND in_progress in a single call. A single value still works —
      // { in: ['open'] } is equivalent to { status: 'open' }.
      ...(status
        ? { status: { in: String(status).split(',').map((s) => s.trim()).filter(Boolean) } }
        : {}),
      ...(phone ? { customer_phone: { contains: phone } } : {}),
      ...(registration
        ? { vehicle: { registration: { contains: normalizeRegistration(String(registration)) } } }
        : {}),
    };

    const [data, total] = await Promise.all([
      prisma.walkInJob.findMany({
        where,
        // healthSheet id only — the vendor list needs to know whether an
        // inspection already exists (so it can send the mechanic straight to
        // the amount instead of re-entering the whole checklist), but not the
        // items themselves. getWalkInJob is where the full sheet is loaded.
        include: {
          vehicle: true,
          healthSheet: { select: { id: true } },
          // The inspection screen builds its cards from these.
          services: true,
        },
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
      include: {
        vehicle: true,
        services: true,
        healthSheet: { include: { items: { include: { component: true } } } },
      },
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

    // Explicit field pick rather than `data: req.body`. The Zod schema already
    // strips unknown keys, so the old form was safe — but it left the write
    // surface defined entirely by a validator two files away, where widening
    // the schema would silently widen what Prisma can write.
    const { customer_name, description, amount_collected, payment_mode } = req.body;
    const job = await prisma.walkInJob.update({
      where: { id: existing.id },
      data: {
        ...(customer_name !== undefined ? { customer_name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(amount_collected !== undefined ? { amount_collected } : {}),
        ...(payment_mode !== undefined ? { payment_mode } : {}),
      },
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
  const { status, amount_collected, payment_mode } = req.body;

  try {
    const job = await prisma.walkInJob.findFirst({
      where: { id: parseInt(req.params.id), vendorId },
    });
    if (!job) return res.status(404).json({ message: 'Walk-in job not found' });

    if (status === 'completed') {
      // Same gate, same rollout rules as booking completion — see
      // services/healthSheetService.js and PlatformSettings in schema.prisma.
      //
      // Deliberately BEFORE the single update below: nothing at all is
      // persisted when this rejects, so the client can send the identical
      // payload again after the inspection and get a clean, complete write.
      const gate = await assertHealthSheetPresent({ createdAt: job.createdAt, walkInJobId: job.id });
      if (!gate.ok) return res.status(409).json({ code: gate.code, message: gate.message });
    }

    const updated = await prisma.walkInJob.update({
      where: { id: job.id },
      data: {
        status,
        // Only written when supplied, so a plain open -> in_progress
        // transition can't blank money already recorded on the job.
        ...(amount_collected !== undefined ? { amount_collected } : {}),
        ...(payment_mode !== undefined ? { payment_mode } : {}),
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
