import prisma from "../../util/prisma.js";



// @desc    Get Vendor Services (My Services)
// @route   GET /service_api/vendor/services
export const getVendorServices = async (req, res) => {
  try {
    const services = await prisma.service.findMany({
      where: { vendorId: req.user.id },
<<<<<<< HEAD
=======
      include: { segmentPrices: true },
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
    });
    res.json(services);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Create Service
// @route   POST /service_api/vendor/services
export const createService = async (req, res) => {
  // console.log('BODY:', req.body);
  // console.log('FILE:', req.file);

<<<<<<< HEAD
  const { name, description, price, duration, category, is_active, image_url: body_image_url } = req.body;
  const image = req.file ? req.file.path : (body_image_url || null);
=======
  const { name, description, price, duration, category, is_active, image_url: body_image_url, segment_prices, vehicle_note } = req.body;
  // uploadSingle uses multer.memoryStorage(), which gives the file a `buffer`
  // and NO `path` — the Cloudinary URL is attached at req.file.cloudinary by
  // the middleware. Reading req.file.path here meant every photo a vendor
  // picked was stored as undefined, so services created in the app were left
  // with a null image_url forever. Same bug already fixed in bookingController.
  const image = req.file?.cloudinary?.secure_url ?? body_image_url ?? null;
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d

  // Handle boolean conversion for FormData strings
  const isActive = is_active === "true" || is_active === true;

  try {
<<<<<<< HEAD
    const service = await prisma.service.create({
      data: {
        vendorId: req.user.id,
        name,
        description,
        price: parseFloat(price),
        duration: parseInt(duration),
        category,
        image_url: image,
        is_active: is_active !== undefined ? isActive : true,
      },
    });
=======
    // Service + its per-segment prices together: a service that "has"
    // segment pricing but is missing rows (or the reverse — orphaned
    // ServiceSegmentPrice rows with no live service) is a state nothing else
    // in this feature expects, and the FK's onDelete: Cascade means it would
    // only be reachable through a partial write like this one.
    const service = await prisma.$transaction(async (tx) => {
      const created = await tx.service.create({
        data: {
          vendorId: req.user.id,
          name,
          description,
          price: parseFloat(price),
          duration: parseInt(duration),
          category,
          image_url: image,
          is_active: is_active !== undefined ? isActive : true,
          vehicle_note: vehicle_note ?? null,
        },
      });

      if (Array.isArray(segment_prices) && segment_prices.length > 0) {
        await tx.serviceSegmentPrice.createMany({
          data: segment_prices.map((sp) => ({ serviceId: created.id, segment: sp.segment, price: sp.price })),
        });
      }

      return tx.service.findUnique({ where: { id: created.id }, include: { segmentPrices: true } });
    });

>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
    res.status(201).json(service);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Update Service
// @route   PUT /service_api/vendor/services/:id

export const updateService = async (req, res) => {
  const serviceId = parseInt(req.params.id);
<<<<<<< HEAD
  const { name, description, price, duration, category, is_active, image_url: body_image_url } = req.body;

  // new image (optional)
  const image = req.file ? req.file.path : body_image_url;
=======
  const { name, description, price, duration, category, is_active, image_url: body_image_url, segment_prices, vehicle_note } = req.body;

  // new image (optional). See createService above for why this is
  // req.file.cloudinary and not req.file.path. Deliberately left `undefined`
  // when neither a file nor an image_url was sent — the spread below treats
  // undefined as "not part of this request" and keeps the existing photo, so
  // editing just a price doesn't wipe the image.
  const image = req.file?.cloudinary?.secure_url ?? body_image_url;
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d

  try {
    // Check service exists & belongs to vendor
    const existingService = await prisma.service.findUnique({
      where: { id: serviceId },
    });

    if (!existingService) {
      return res.status(404).json({ message: "Service not found" });
    }

    if (existingService.vendorId !== req.user.id) {
      return res
        .status(403)
        .json({ message: "Not authorized to update this service" });
    }

    // Boolean handling (FormData safe)
    let isActive;
    if (is_active !== undefined) {
      isActive = is_active === "true" || is_active === true;
    }

<<<<<<< HEAD
    const updatedService = await prisma.service.update({
      where: { id: serviceId },
      data: {
        ...(name && { name }),
        ...(description && { description }),
        ...(price !== undefined && { price: parseFloat(price) }),
        ...(duration !== undefined && { duration: parseInt(duration) }),
        ...(category && { category }),
        ...(image !== undefined && { image_url: image }),
        ...(is_active !== undefined && { is_active: isActive }),
      },
=======
    const updatedService = await prisma.$transaction(async (tx) => {
      const updated = await tx.service.update({
        where: { id: serviceId },
        data: {
          ...(name && { name }),
          ...(description && { description }),
          ...(price !== undefined && { price: parseFloat(price) }),
          ...(duration !== undefined && { duration: parseInt(duration) }),
          ...(category && { category }),
          ...(image !== undefined && { image_url: image }),
          ...(is_active !== undefined && { is_active: isActive }),
          ...(vehicle_note !== undefined && { vehicle_note }),
        },
      });

      // Undefined means "the field wasn't in this request" (edit some other
      // part of the form) and must leave existing prices alone. An empty
      // array IS meaningful — it's how the vendor removes segment pricing and
      // reverts the service to a single flat price — so it's handled
      // separately from "field absent".
      if (segment_prices !== undefined) {
        // Full replace, not a diff: with no natural row id on the client
        // side, "replace the set" is unambiguous where "upsert this subset"
        // would leave stale segments (a segment the vendor just deselected)
        // sitting in the database forever.
        await tx.serviceSegmentPrice.deleteMany({ where: { serviceId } });
        if (segment_prices.length > 0) {
          await tx.serviceSegmentPrice.createMany({
            data: segment_prices.map((sp) => ({ serviceId, segment: sp.segment, price: sp.price })),
          });
        }
      }

      return tx.service.findUnique({ where: { id: serviceId }, include: { segmentPrices: true } });
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
    });

    res.status(200).json(updatedService);
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
//




