import prisma from "../../util/prisma.js";



// @desc    Get Vendor Availability
// @route   GET /service_api/vendor/:vendorId/availability
export const getAvailability = async (req, res) => {
    const vendorId = parseInt(req.params.vendorId);
    if (req.user.id !== vendorId) {
        return res.status(403).json({ message: 'Not authorized' });
    }
    try {
        const availability = await prisma.availability.findMany({
            where: { vendorId }
        });
        res.json(availability);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

// @desc    Create/Update Availability
// @route   POST /service_api/vendor/:vendorId/availability/create
export const createAvailability = async (req, res) => {
    const vendorId = parseInt(req.params.vendorId);
    if (req.user.id !== vendorId) {
        return res.status(403).json({ message: 'Not authorized' });
    }
    const { day_of_week, start_time, end_time, is_available } = req.body;
    try {
        const item = await prisma.availability.create({
            data: {
                vendorId,
                day_of_week,
                start_time,
                end_time,
                is_available: is_available !== undefined ? is_available : true
            }
        });
        res.status(201).json(item);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}




