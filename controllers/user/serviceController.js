import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// @desc    Get All Services (Public)
// @route   GET /service_api/user/services
export const getAllServices = async (req, res) => {
    try {
        const services = await prisma.service.findMany({
            include: { vendor: { include: { vendorProfile: true } } }
        });

        // Enrich data for frontend parity
        const enrichedServices = services.map(service => ({
            ...service,
            image_url: service.image_url ? `${req.protocol}://${req.get('host')}${service.image_url}` : null,
            image: service.image_url ? `${req.protocol}://${req.get('host')}${service.image_url}` : null,
            vendor_name: service.vendor?.vendorProfile?.business_name || 'Vendor',
            vendor_image: service.vendor?.vendorProfile?.image || null
        }));

        res.json(enrichedServices);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

// @desc    Get Service By ID
// @route   GET /service_api/user/services/:id
export const getServiceById = async (req, res) => {
    try {
        const service = await prisma.service.findUnique({
            where: { id: parseInt(req.params.id) },
            include: { vendor: { include: { vendorProfile: true } } }
        });

        if (service) {
            const enrichedService = {
                ...service,
                image_url: service.image_url ? `${req.protocol}://${req.get('host')}${service.image_url}` : null,
                image: service.image_url ? `${req.protocol}://${req.get('host')}${service.image_url}` : null,
                vendor_name: service.vendor?.vendorProfile?.business_name || 'Vendor',
                vendor_image: service.vendor?.vendorProfile?.image || null
            };
            res.json(enrichedService);
        } else {
            res.status(404).json({ message: 'Service not found' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

// @desc    Get Service Categories
// @route   GET /service_api/services/categories/
export const getServiceCategories = async (req, res) => {
    try {
        const categories = await prisma.service.groupBy({
            by: ['category'],
        });
        const formatted = categories.map(c => ({ name: c.category }));
        res.json(formatted);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

// @desc    Search Vendors by Location (Haversine)
// @route   GET /service_api/search/vendors/location/
export const searchVendorsByLocation = async (req, res) => {
    const { latitude, longitude, radius = 10 } = req.query;

    if (!latitude || !longitude) {
        return res.status(400).json({ error: "Invalid or missing latitude/longitude" });
    }

    try {
        const vendors = await prisma.vendorProfile.findMany({
            where: {
                status: 'approved',
                latitude: { not: null },
                longitude: { not: null }
            },
            include: { user: true }
        });

        const nearbyVendors = vendors.filter(vendor => {
            const lat1 = parseFloat(latitude);
            const lon1 = parseFloat(longitude);
            const lat2 = vendor.latitude;
            const lon2 = vendor.longitude;

            const R = 6371;
            const dLat = (lat2 - lat1) * (Math.PI / 180);
            const dLon = (lon2 - lon1) * (Math.PI / 180);
            const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            const d = R * c;

            return d <= parseFloat(radius);
        });

        const vendorIds = nearbyVendors.map(v => v.userId);
        const services = await prisma.service.findMany({
            where: { vendorId: { in: vendorIds } }
        });

        const formattedVendors = nearbyVendors.map(v => ({
            id: v.userId,
            business_name: v.business_name,
            address: v.address,
            latitude: v.latitude,
            longitude: v.longitude,
            service_area_radius: 10
        }));

        res.json({
            vendors: formattedVendors,
            services: services
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}
