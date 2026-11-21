import { acceptOwnCloudinaryUrl } from "../../util/cloudinary.js";
import prisma from "../../util/prisma.js";
import { planServicePricingWrite, synthesiseLegacyLines, withServicePricing } from "../../util/pricingV2.js";
import { checkPricingRules } from "../../validators/vendor/serviceValidators.js";

// Every vendor service response carries the pricing v2 fields
// (docs/PRICING_V2_API.md section 1), so both relations are always loaded.
const SERVICE_INCLUDE = { segmentPrices: true, priceLines: true };

// Fields that can change a service's lines / price / segment prices. A
// partial update that sends none of these (e.g. the pause toggle, which sends
// only { is_active }) must leave the stored pricing exactly as it is.
const PRICING_KEYS = ['price', 'segment_prices', 'price_lines', 'pricing_type', 'inspection_fee'];

// The text-only v2 fields: stored as sent, never touch the lines.
const pricingTextData = (body) => ({
  ...(body.inclusions !== undefined && { inclusions: body.inclusions }),
  ...(body.exclusions !== undefined && { exclusions: body.exclusions }),
  ...(body.price_change_note !== undefined && { price_change_note: body.price_change_note ?? null }),
  ...(body.tax_inclusive !== undefined && { tax_inclusive: body.tax_inclusive }),
  ...(body.inspection_fee !== undefined && { inspection_fee: body.inspection_fee }),
});

const toPlainLines = (lines) =>
  lines.map((l, i) => ({
    segment: l.segment ?? null,
    kind: l.kind,
    name: l.name,
    qty: Number(l.qty?.toString?.() ?? l.qty),
    unit_price: Number(l.unit_price?.toString?.() ?? l.unit_price),
    sort_order: l.sort_order ?? i,
  }));

/** Writes the planned lines and segment prices inside the caller's transaction. */
const writePlannedPricing = async (tx, serviceId, plan) => {
  if (plan.lines) {
    // Full replace: lines have no client-side identity, and a service has at
    // most 100 of them, so "replace the set" is both simple and unambiguous.
    await tx.servicePriceLine.deleteMany({ where: { serviceId } });
    if (plan.lines.length > 0) {
      await tx.servicePriceLine.createMany({
        data: plan.lines.map((l) => ({ ...l, serviceId })),
      });
    }
  }
  if (plan.segmentPrices) {
    // Same full-replace rule the old segment_prices handling used: an empty
    // set is meaningful (removes segment pricing), and for v2 the set is
    // derived from the lines, so a segment with no lines loses its price.
    await tx.serviceSegmentPrice.deleteMany({ where: { serviceId } });
    if (plan.segmentPrices.length > 0) {
      await tx.serviceSegmentPrice.createMany({
        data: plan.segmentPrices.map((sp) => ({ serviceId, segment: sp.segment, price: sp.price })),
      });
    }
  }
};

const validationError = (res, issues) =>
  res.status(400).json({
    success: false,
    message: 'Validation Error',
    code: 'VALIDATION_ERROR',
    errors: issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
  });

// @desc    Get Vendor Services (My Services)
// @route   GET /service_api/vendor/services
export const getVendorServices = async (req, res) => {
  try {
    const services = await prisma.service.findMany({
      where: { vendorId: req.user.id },
      include: SERVICE_INCLUDE,
    });
    res.json(services.map(withServicePricing));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Create Service
// @route   POST /service_api/vendor/services
export const createService = async (req, res) => {
  // `protect` only confirms the caller has a valid user access token -- it
  // does not check role. Without this, any customer account could publish
  // a "service" into the public marketplace under vendorId: req.user.id,
  // since the write below trusts the caller's own id with no role check.
  if (req.user.role !== 'vendor') {
    return res.status(403).json({ message: 'Only vendor accounts can create services' });
  }

  const { name, description, price, duration, category, is_active, image_url: body_image_url, segment_prices, vehicle_note } = req.body;
  // uploadSingle uses multer.memoryStorage(), which gives the file a `buffer`
  // and NO `path` — the Cloudinary URL is attached at req.file.cloudinary by
  // the middleware. Reading req.file.path here meant every photo a vendor
  // picked was stored as undefined, so services created in the app were left
  // with a null image_url forever. Same bug already fixed in bookingController.
  // Security A-014: body image URLs must be our own Cloudinary assets.
  const image = req.file?.cloudinary?.secure_url ?? acceptOwnCloudinaryUrl(body_image_url) ?? null;

  // Handle boolean conversion for FormData strings
  const isActive = is_active === "true" || is_active === true;

  // Pricing v2: the server derives price + segment prices from the lines
  // (legacy payloads get synthesised lines). Validated by createServiceSchema.
  const plan = planServicePricingWrite({
    pricing_type: req.body.pricing_type,
    price_lines: req.body.price_lines,
    inspection_fee: req.body.inspection_fee,
    price: price !== undefined ? parseFloat(price) : undefined,
    segment_prices,
  });

  try {
    // Service + its per-segment prices + lines together: a service that
    // "has" segment pricing but is missing rows (or the reverse) is a state
    // nothing else in this feature expects, and the FK's onDelete: Cascade
    // means it would only be reachable through a partial write like this one.
    const service = await prisma.$transaction(async (tx) => {
      const created = await tx.service.create({
        data: {
          vendorId: req.user.id,
          name,
          description,
          price: plan.price,
          duration: parseInt(duration),
          category,
          image_url: image,
          is_active: is_active !== undefined ? isActive : true,
          vehicle_note: vehicle_note ?? null,
          pricing_type: plan.pricingType,
          breakdown_confirmed: plan.breakdownConfirmed,
          ...pricingTextData(req.body),
        },
      });

      await writePlannedPricing(tx, created.id, {
        ...plan,
        // On create there is nothing to delete; an absent segment_prices on a
        // legacy payload simply means "no segment rows".
        segmentPrices: plan.segmentPrices ?? [],
      });

      return tx.service.findUnique({ where: { id: created.id }, include: SERVICE_INCLUDE });
    });

    res.status(201).json(withServicePricing(service));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

/**
 * Decide what an update does to the stored pricing (doc section 1, "Which
 * path an update takes"). Returns null when no pricing field was sent.
 */
export const planServiceUpdate = (body, existing) => {
  const sent = (k) => body[k] !== undefined;
  if (!PRICING_KEYS.some(sent)) return null;

  const storedLines = toPlainLines([...(existing.priceLines ?? [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)));
  const pricingType = body.pricing_type ?? existing.pricing_type ?? 'fixed';
  const inspectionFee = sent('inspection_fee') ? body.inspection_fee : existing.inspection_fee;

  // 1. Real lines sent: the v2 path.
  if (Array.isArray(body.price_lines)) {
    return planServicePricingWrite({ pricing_type: pricingType, price_lines: body.price_lines, inspection_fee: inspectionFee });
  }

  // 2. Old clients: price / segment_prices without lines.
  if ((sent('price') || sent('segment_prices')) && body.pricing_type !== 'inspection') {
    const price = sent('price') ? body.price : Number(existing.price);
    const plan = planServicePricingWrite({
      price,
      // The synthesised lines need the segment prices even when this request
      // did not send them; null on the result keeps the stored rows as-is.
      segment_prices: sent('segment_prices') ? body.segment_prices : (existing.segmentPrices ?? []).map((sp) => ({ segment: sp.segment, price: Number(sp.price) })),
    });
    return { ...plan, segmentPrices: sent('segment_prices') ? plan.segmentPrices : null };
  }

  // 3. Only pricing_type / inspection_fee: keep the stored lines (or, for a
  // service saved before v2, its legacy lines) and recompute the totals under
  // the new type/fee.
  let lines = storedLines;
  if (lines.length === 0 && pricingType !== 'inspection') {
    lines = toPlainLines(synthesiseLegacyLines(existing.price, existing.segmentPrices ?? []));
  }
  const plan = planServicePricingWrite({
    pricing_type: pricingType,
    price_lines: pricingType === 'inspection' && lines.length === 0 ? undefined : lines,
    inspection_fee: inspectionFee,
  });
  return {
    ...plan,
    // Re-writing identical lines would only churn their ids.
    lines: storedLines.length > 0 ? null : plan.lines,
    // The vendor did not (re)confirm a breakdown in this request.
    breakdownConfirmed: storedLines.length > 0 ? Boolean(existing.breakdown_confirmed) : false,
  };
};

// @desc    Update Service
// @route   PUT /service_api/vendor/services/:id

export const updateService = async (req, res) => {
  const serviceId = parseInt(req.params.id);
  const { name, description, duration, category, is_active, image_url: body_image_url, vehicle_note } = req.body;

  // new image (optional). See createService above for why this is
  // req.file.cloudinary and not req.file.path. Deliberately left `undefined`
  // when neither a file nor an image_url was sent — the spread below treats
  // undefined as "not part of this request" and keeps the existing photo, so
  // editing just a price doesn't wipe the image.
  // Security A-014: body image URLs must be our own Cloudinary assets.
  const image = req.file?.cloudinary?.secure_url ?? acceptOwnCloudinaryUrl(body_image_url);

  try {
    // Check service exists & belongs to vendor
    const existingService = await prisma.service.findUnique({
      where: { id: serviceId },
      include: SERVICE_INCLUDE,
    });

    if (!existingService) {
      return res.status(404).json({ message: "Service not found" });
    }

    if (existingService.vendorId !== req.user.id) {
      return res
        .status(403)
        .json({ message: "Not authorized to update this service" });
    }

    const plan = planServiceUpdate(req.body, existingService);

    // A legacy payload is stored as 'fixed', so 'starting' needs real lines.
    if (plan && !Array.isArray(req.body.price_lines) && req.body.pricing_type === 'starting' && plan.pricingType === 'fixed') {
      return validationError(res, [{ path: ['price_lines'], message: "A 'starting' price needs price_lines" }]);
    }

    // Type rules on the service as it will be after this update. Only run
    // when something they depend on was sent, so e.g. a pause toggle never
    // fails on an older row.
    if (plan || req.body.inclusions !== undefined) {
      const effectiveType = plan?.pricingType ?? existingService.pricing_type ?? 'fixed';
      let effectiveLines = plan?.lines ?? existingService.priceLines ?? [];
      if (effectiveLines.length === 0 && effectiveType !== 'inspection') {
        effectiveLines = synthesiseLegacyLines(existingService.price, existingService.segmentPrices ?? []);
      }
      const issues = checkPricingRules({
        pricing_type: effectiveType,
        price_lines: effectiveLines,
        inclusions: req.body.inclusions ?? existingService.inclusions ?? [],
        inspection_fee: req.body.inspection_fee !== undefined ? req.body.inspection_fee : existingService.inspection_fee,
      });
      if (issues.length > 0) return validationError(res, issues);
    }

    // Boolean handling (FormData safe)
    let isActive;
    if (is_active !== undefined) {
      isActive = is_active === "true" || is_active === true;
    }

    const updatedService = await prisma.$transaction(async (tx) => {
      await tx.service.update({
        where: { id: serviceId },
        data: {
          ...(name && { name }),
          // `!== undefined` (not truthy) so a garage can clear the description
          // to "" — it is optional since 2026-11-21.
          ...(description !== undefined && { description }),
          ...(duration !== undefined && { duration: parseInt(duration) }),
          ...(category && { category }),
          ...(image !== undefined && { image_url: image }),
          ...(is_active !== undefined && { is_active: isActive }),
          ...(vehicle_note !== undefined && { vehicle_note }),
          ...pricingTextData(req.body),
          ...(plan && {
            price: plan.price,
            pricing_type: plan.pricingType,
            breakdown_confirmed: plan.breakdownConfirmed,
          }),
        },
      });

      if (plan) await writePlannedPricing(tx, serviceId, plan);

      return tx.service.findUnique({ where: { id: serviceId }, include: SERVICE_INCLUDE });
    });

    res.status(200).json(withServicePricing(updatedService));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Delete Service
// @route   DELETE /service_api/vendor/services/:id
export const deleteService = async (req, res) => {
  try {
    await prisma.service.delete({
      where: { id: parseInt(req.params.id), vendorId: req.user.id },
    });
    res.json({ message: "Service removed" });
  } catch (error) {
    console.error(error);
    res.status(404).json({ message: "Service not found" });
  }
};
