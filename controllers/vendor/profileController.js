
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// @desc    Get vendor profile
// @route   GET /accounts/vendor/profile/
// @access  Private (Vendor)
export const getVendorProfile = async (req, res) => {
    try {
        const vendorProfile = await prisma.vendorProfile.findUnique({
            where: { userId: req.user.id },
            include: { user: true }
        });

        if (vendorProfile) {
            res.json(vendorProfile);
        } else {
            res.status(404).json({ message: 'Vendor profile not found' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Update vendor profile
// @route   PUT /accounts/vendor/profile/
// @access  Private (Vendor)
export const updateVendorProfile = async (req, res) => {
    const { business_name, phone, address, description } = req.body;

    try {
        const vendorProfile = await prisma.vendorProfile.update({
            where: { userId: req.user.id },
            data: {
                business_name,
                phone,
                address,
                description
            }
        });

        res.json(vendorProfile);
    } catch (error) {
        console.error(error);
        res.status(404).json({ message: 'Vendor profile not found' });
    }
};

// @desc    Create vendor profile
// @route   POST /accounts/vendor/profile/
// @access  Private
export const createVendorProfile = async (req, res) => {
    const { business_name, phone, address, description } = req.body;

    try {
         // Check if profile already exists
         const existingProfile = await prisma.vendorProfile.findUnique({
            where: { userId: req.user.id }
        });

        if (existingProfile) {
            return res.status(400).json({ message: 'Vendor profile already exists' });
        }

        const vendorProfile = await prisma.vendorProfile.create({
            data: {
                userId: req.user.id,
                business_name,
                phone,
                address,
                description,
                onboarding_completed: true
            }
        });
        
        // Ensure user role is updated to vendor if not already
        await prisma.user.update({
            where: { id: req.user.id },
            data: { role: 'vendor' }
        });

        res.status(201).json(vendorProfile);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};
