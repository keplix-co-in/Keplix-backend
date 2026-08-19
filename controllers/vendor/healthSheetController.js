import prisma from '../../util/prisma.js';
import Logger from '../../util/logger.js';
import { generatePublicToken } from '../../util/publicToken.js';

/** Field-naming convention shared with the partner app: one file field per
 * inspection component, so a photo can never be silently mis-associated with
 * the wrong component the way a flat `photos[]` + index array could be. */
const photoFieldFor = (componentKey) => `photo_${componentKey}`;

// @desc    Submit a health sheet for a Booking or a WalkInJob
// @route   POST /service_api/vendor/health-sheets
export const createHealthSheet = async (req, res) => {
  const vendorId = req.user.id;
  const { bookingId, walkInJobId, odometer_km, overall_notes, items } = req.body;

  try {
    // Ownership check. For a booking this is the exact fix applied to
    // updateBookingStatus in Phase 0 — vendor is reached via
    // serviceId -> Service.vendorId, Booking has no vendorId of its own.
    let vehicleId = null;
    if (bookingId) {
      const booking = await prisma.booking.findFirst({
        where: { id: bookingId, service: { vendorId } },
        select: { id: true },
      });
      if (!booking) return res.status(404).json({ message: 'Booking not found' });
    } else {
      const job = await prisma.walkInJob.findFirst({
        where: { id: walkInJobId, vendorId },
        select: { id: true, vehicleId: true },
      });
      if (!job) return res.status(404).json({ message: 'Walk-in job not found' });
      vehicleId = job.vehicleId;
    }

    // One sheet per parent — the DB has a unique index on bookingId/walkInJobId
    // for exactly this, but check first so a resubmission gets a clear 409
    // instead of a raw unique-constraint error.
    const existing = await prisma.healthSheet.findFirst({
      where: bookingId ? { bookingId } : { walkInJobId },
      select: { id: true },
    });
    if (existing) {
      return res.status(409).json({
        code: 'HEALTH_SHEET_ALREADY_SUBMITTED',
        message: 'A health sheet has already been submitted for this job.',
      });
    }

    // An item is EITHER a fixed inspection component (booking path) OR one of
    // the services chosen on a walk-in. The two are validated separately so a
    // walk-in sheet made of services is never rejected for "missing"
    // components, and the booking path keeps its exact previous behaviour.
    const componentItems = items.filter((i) => i.component_key);
    const serviceItems = items.filter((i) => i.walk_in_service_id);

    const mixed = items.filter((i) => i.component_key && i.walk_in_service_id);
    if (mixed.length) {
      return res.status(400).json({
        message: 'An item may reference either a component or a walk-in service, not both.',
      });
    }
    const orphans = items.filter((i) => !i.component_key && !i.walk_in_service_id);
    if (orphans.length) {
      return res.status(400).json({
        message: 'Every item must reference a component or a walk-in service.',
      });
    }

    // Required components come from the live template table, not a
    // hardcoded list — this is the whole point of HealthComponent existing.
    const activeComponents = await prisma.healthComponent.findMany({
      where: { is_active: true },
      select: { id: true, key: true, label: true },
    });
    const byKey = new Map(activeComponents.map((c) => [c.key, c]));

    const unknownKeys = componentItems.filter((i) => !byKey.has(i.component_key));
    if (unknownKeys.length) {
      return res.status(400).json({
        message: `Unknown inspection component(s): ${unknownKeys.map((i) => i.component_key).join(', ')}`,
      });
    }

    // Completeness applies only to a component-based sheet. A service-based
    // sheet describes the work actually selected, so demanding all five
    // components would make it impossible to submit.
    if (componentItems.length) {
      const missingKeys = [...byKey.keys()].filter(
        (k) => !componentItems.some((i) => i.component_key === k)
      );
      if (missingKeys.length) {
        return res.status(400).json({
          message: `Missing inspection item(s): ${missingKeys.join(', ')}`,
        });
      }
    }

    // Service ids must belong to THIS walk-in job — otherwise a vendor could
    // attach another job's services (or another vendor's) to their sheet.
    const byServiceId = new Map();
    if (serviceItems.length) {
      if (!walkInJobId) {
        return res.status(400).json({
          message: 'Service items are only valid on a walk-in job.',
        });
      }
      const jobServices = await prisma.walkInJobService.findMany({
        where: {
          id: { in: serviceItems.map((i) => i.walk_in_service_id) },
          walkInJobId,
        },
        select: { id: true, name: true, price: true },
      });
      for (const s of jobServices) byServiceId.set(s.id, s);

      const unknownServices = serviceItems.filter((i) => !byServiceId.has(i.walk_in_service_id));
      if (unknownServices.length) {
        return res.status(400).json({
          message: 'One or more services do not belong to this walk-in job.',
        });
      }
    }

    // Group uploaded files by their photo_<key> field name. uploadAny()
    // leaves req.files as an array (unlike uploadFieldss's object-by-field
    // shape) — see middleware/uploadMiddleware.js.
    const filesByField = {};
    for (const file of req.files || []) {
      (filesByField[file.fieldname] ??= []).push(file);
    }

    const sheet = await prisma.$transaction(async (tx) => {
      const sheet = await tx.healthSheet.create({
        data: {
          bookingId: bookingId ?? null,
          walkInJobId: walkInJobId ?? null,
          vendorId,
          vehicleId,
          odometer_km,
          overall_notes,
          public_token: generatePublicToken(),
        },
      });

      for (const item of items) {
        const component = item.component_key ? byKey.get(item.component_key) : null;
        const service = item.walk_in_service_id ? byServiceId.get(item.walk_in_service_id) : null;

        // Photo field names follow the same photo_<key> convention for both
        // kinds; services use the id the client also sends as the key.
        const photoKey = item.component_key ?? `svc-${item.walk_in_service_id}`;
        const files = filesByField[photoFieldFor(photoKey)] || [];
        // The DB CHECK constraint also enforces this, but truncating here
        // gives a predictable result instead of a 500 from a raw constraint
        // violation if a client sends 3 photos for one component.
        const photos = files.slice(0, 2).map((f) => f.cloudinary.secure_url);

        await tx.healthSheetItem.create({
          data: {
            healthSheetId: sheet.id,
            componentId: component ? component.id : null,
            walkInJobServiceId: service ? service.id : null,
            // Denormalised so every reader has one field to read rather than
            // branching on which relation is set. Price falls back to the
            // snapshot taken at check-in when the vendor doesn't override it.
            label: component ? component.label : service?.name ?? null,
            status: item.status ?? null,
            price: item.price ?? service?.price ?? null,
            notes: item.notes,
            photos,
          },
        });
      }

      return sheet;
    });

    const full = await prisma.healthSheet.findUnique({
      where: { id: sheet.id },
      include: { items: { include: { component: true } } },
    });

    return res.status(201).json({ healthSheet: full });
  } catch (error) {
    Logger.error(`[HealthSheet] createHealthSheet failed: ${error.message}`);
    return res.status(500).json({ message: 'Server Error' });
  }
};

// @desc    Fetch a health sheet the vendor owns, by its own id
// @route   GET /service_api/vendor/health-sheets/:id
export const getHealthSheet = async (req, res) => {
  const vendorId = req.user.id;

  try {
    const sheet = await prisma.healthSheet.findFirst({
      where: { id: parseInt(req.params.id), vendorId },
      include: { items: { include: { component: true } } },
    });
    if (!sheet) return res.status(404).json({ message: 'Health sheet not found' });
    return res.json({ healthSheet: sheet });
  } catch (error) {
    Logger.error(`[HealthSheet] getHealthSheet failed: ${error.message}`);
    return res.status(500).json({ message: 'Server Error' });
  }
};

// @desc    Look up a health sheet by its parent Booking
// @route   GET /service_api/vendor/bookings/:id/health-sheet
export const getHealthSheetForBooking = async (req, res) => {
  await getHealthSheetForParent(req, res, { bookingId: parseInt(req.params.id) });
};

// @desc    Look up a health sheet by its parent WalkInJob
// @route   GET /service_api/vendor/walk-in-jobs/:id/health-sheet
export const getHealthSheetForWalkInJob = async (req, res) => {
  await getHealthSheetForParent(req, res, { walkInJobId: parseInt(req.params.id) });
};

async function getHealthSheetForParent(req, res, parentWhere) {
  const vendorId = req.user.id;
  try {
    const sheet = await prisma.healthSheet.findFirst({
      where: { ...parentWhere, vendorId },
      include: { items: { include: { component: true } } },
    });
    if (!sheet) return res.status(404).json({ message: 'Health sheet not found' });
    return res.json({ healthSheet: sheet });
  } catch (error) {
    Logger.error(`[HealthSheet] getHealthSheetForParent failed: ${error.message}`);
    return res.status(500).json({ message: 'Server Error' });
  }
}

/** Active components in display order — what the partner app renders the
 * checklist from, and what field names (photo_<key>) it must submit under. */
// @route   GET /service_api/vendor/health-components
export const listHealthComponents = async (req, res) => {
  try {
    const components = await prisma.healthComponent.findMany({
      where: { is_active: true },
      orderBy: { display_order: 'asc' },
    });
    return res.json({ data: components });
  } catch (error) {
    Logger.error(`[HealthSheet] listHealthComponents failed: ${error.message}`);
    return res.status(500).json({ message: 'Server Error' });
  }
};
