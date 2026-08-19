import prisma from '../../util/prisma.js';
import { isOfferLive } from '../../util/offers.js';

const withTargets = {
  targets: {
    select: {
      vendorId: true,
      vendor: { select: { id: true, vendorProfile: { select: { business_name: true } } } },
    },
  },
};

// @desc    List every offer slot, including inactive and scheduled ones —
//          unlike the public endpoint, which only returns live slots.
// @route   GET /admin/offer-slots
export const listOfferSlotsAdmin = async (req, res) => {
  try {
    const slots = await prisma.offerSlot.findMany({
      orderBy: { display_order: 'asc' },
      include: withTargets,
    });

    // `is_live` is computed rather than stored: the admin needs to see whether a
    // slot is showing RIGHT NOW, which `is_active` alone doesn't answer once
    // dates are involved. Same helper the public endpoint filters with, so the
    // two can't disagree.
    const now = new Date();
    const data = slots.map((slot) => ({
      ...slot,
      is_live: isOfferLive(slot, now),
      vendor_ids: slot.targets.map((t) => t.vendorId),
    }));

    return res.json({ data });
  } catch (error) {
    return res.status(500).json({ message: 'Server Error' });
  }
};

// @desc    Create a placement slot.
// @route   POST /admin/offer-slots
export const createOfferSlot = async (req, res) => {
  const {
    key, label, description, headline, body, badge_text,
    image_url, is_active, starts_at, ends_at, display_order,
  } = req.body;

  try {
    const slot = await prisma.offerSlot.create({
      data: {
        key,
        label,
        description,
        headline,
        body,
        badge_text,
        image_url,
        is_active: is_active ?? false,
        starts_at,
        ends_at,
        display_order: display_order ?? 0,
      },
    });
    return res.status(201).json({ slot });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ message: 'An offer slot with this key already exists.' });
    }
    return res.status(500).json({ message: 'Server Error' });
  }
};

// @desc    Edit a slot's content, schedule or active state. `key` is immutable.
// @route   PATCH /admin/offer-slots/:id
export const updateOfferSlot = async (req, res) => {
  const fields = [
    'label', 'description', 'headline', 'body', 'badge_text',
    'image_url', 'is_active', 'starts_at', 'ends_at', 'display_order',
  ];

  try {
    // Explicit pick, and `!== undefined` so a field can be cleared to null but
    // an omitted field is left alone — this is a PATCH, not a replace.
    const data = {};
    for (const f of fields) {
      if (req.body[f] !== undefined) data[f] = req.body[f];
    }

    const slot = await prisma.offerSlot.update({
      where: { id: parseInt(req.params.id) },
      data,
      include: withTargets,
    });
    return res.json({ slot });
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ message: 'Offer slot not found' });
    return res.status(500).json({ message: 'Server Error' });
  }
};

// @desc    Create or update a slot addressed by its placement key.
//
//          The admin edits a fixed list of placements defined by the client
//          code, so a placement can legitimately have no row yet (a key shipped
//          in the app before anyone set its content). Upserting by key means the
//          admin never has to know whether a row exists.
// @route   PUT /admin/offer-slots/by-key/:key
export const upsertOfferSlotByKey = async (req, res) => {
  const { key } = req.params;
  const {
    label, description, headline, body, badge_text,
    image_url, is_active, starts_at, ends_at, display_order,
  } = req.body;

  try {
    const content = {
      ...(description !== undefined ? { description } : {}),
      ...(headline !== undefined ? { headline } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(badge_text !== undefined ? { badge_text } : {}),
      ...(image_url !== undefined ? { image_url } : {}),
      ...(is_active !== undefined ? { is_active } : {}),
      ...(starts_at !== undefined ? { starts_at } : {}),
      ...(ends_at !== undefined ? { ends_at } : {}),
      ...(display_order !== undefined ? { display_order } : {}),
    };

    const slot = await prisma.offerSlot.upsert({
      where: { key },
      update: { ...content, ...(label !== undefined ? { label } : {}) },
      // `label` is required on create, so fall back to the key rather than
      // failing when the caller only sent content.
      create: { key, label: label || key, ...content },
      include: withTargets,
    });

    return res.json({ slot });
  } catch (error) {
    return res.status(500).json({ message: 'Server Error' });
  }
};

// @desc    Replace a slot's vendor targeting. An empty array means "all vendors".
// @route   PUT /admin/offer-slots/:id/targets
export const setOfferSlotTargets = async (req, res) => {
  const offerSlotId = parseInt(req.params.id);
  const { vendor_ids } = req.body;

  try {
    const slot = await prisma.offerSlot.findUnique({ where: { id: offerSlotId } });
    if (!slot) return res.status(404).json({ message: 'Offer slot not found' });

    // Only real vendors: a stale or mistyped id would otherwise be stored and
    // silently narrow the audience to nobody.
    const unique = [...new Set(vendor_ids)];
    const vendors = unique.length
      ? await prisma.user.findMany({
          where: { id: { in: unique }, vendorProfile: { isNot: null } },
          select: { id: true },
        })
      : [];

    const valid = vendors.map((v) => v.id);
    const rejected = unique.filter((id) => !valid.includes(id));
    if (rejected.length) {
      return res.status(400).json({
        message: `Not valid vendors: ${rejected.join(', ')}`,
      });
    }

    // Replace wholesale in a transaction so a partial write can't leave the slot
    // targeted at some arbitrary subset.
    await prisma.$transaction([
      prisma.offerSlotVendor.deleteMany({ where: { offerSlotId } }),
      ...(valid.length
        ? [prisma.offerSlotVendor.createMany({ data: valid.map((vendorId) => ({ offerSlotId, vendorId })) })]
        : []),
    ]);

    const updated = await prisma.offerSlot.findUnique({
      where: { id: offerSlotId },
      include: withTargets,
    });
    return res.json({ slot: updated });
  } catch (error) {
    return res.status(500).json({ message: 'Server Error' });
  }
};

// @desc    Delete a slot. Targets cascade.
// @route   DELETE /admin/offer-slots/:id
export const deleteOfferSlot = async (req, res) => {
  try {
    await prisma.offerSlot.delete({ where: { id: parseInt(req.params.id) } });
    return res.json({ success: true });
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ message: 'Offer slot not found' });
    return res.status(500).json({ message: 'Server Error' });
  }
};
