import prisma from "../../util/prisma.js";



// @desc    Get Vendor Services (My Services)
// @route   GET /service_api/vendor/services
export const getVendorServices = async (req, res) => {
  try {
    const services = await prisma.service.findMany({
      where: { vendorId: req.user.id },
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

  const { name, description, price, duration, category, is_active, image_url: body_image_url } = req.body;
  const image = req.file ? req.file.path : (body_image_url || null);

  // Handle boolean conversion for FormData strings
  const isActive = is_active === "true" || is_active === true;

  try {
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
  const { name, description, price, duration, category, is_active, image_url: body_image_url } = req.body;

  // new image (optional)
  const image = req.file ? req.file.path : body_image_url;

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




