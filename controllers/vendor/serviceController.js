import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// @desc    Get Vendor Services (My Services)
// @route   GET /service_api/vendor/services
export const getVendorServices = async (req, res) => {
    try {
        const services = await prisma.service.findMany({
            where: { vendorId: req.user.id }
        });
        res.json(services);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

// @desc    Create Service
// @route   POST /service_api/vendor/services
export const createService = async (req, res) => {
    const { name, description, price, duration, category, is_active } = req.body;
    const image = req.file ? `/media/${req.file.filename}` : null;

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
                is_active: is_active !== undefined ? is_active : true
            }
        });
        res.status(201).json(service);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

// @desc    Update Service
// @route   PUT /service_api/vendor/services/:id
export const updateService = async (req, res) => {
    const { name, description, price, duration, category } = req.body;
    try {
        const service = await prisma.service.update({
            where: { id: parseInt(req.params.id), vendorId: req.user.id },
            data: {
                name,
                description,
                price: price ? parseFloat(price) : undefined,
                duration: duration ? parseInt(duration) : undefined,
                category
            }
        });
        res.json(service);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error / Not Found' });
    }
}

// @desc    Delete Service
// @route   DELETE /service_api/vendor/services/:id
export const deleteService = async (req, res) => {
    try {
        await prisma.service.delete({
            where: { id: parseInt(req.params.id), vendorId: req.user.id }
        });
        res.json({ message: 'Service removed' });
    } catch (error) {
        console.error(error);
        res.status(404).json({ message: 'Service not found' });
    }
}
