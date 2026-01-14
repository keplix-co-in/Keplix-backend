
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
    // Destructure all possible fields from the validated body
    const { 
        business_name, business_type, description,
        phone, alternate_phone, email,
        owner_name, date_of_birth,
        address, street, area, city, state, pincode, landmark,
        latitude, longitude,
        gst_number, has_gst, tax_type,
        operating_hours, breaks, holidays,
        onboarding_completed // if sent by frontend
    } = req.body;

    const updates = { 
        business_name, business_type, description,
        phone, alternate_phone, email,
        owner_name, date_of_birth,
        address, street, area, city, state, pincode, landmark,
        latitude, longitude,
        gst_number, has_gst, tax_type,
        operating_hours, breaks, holidays
    };

    if (onboarding_completed !== undefined) {
        updates.onboarding_completed = onboarding_completed;
    }

    // Handle Image upload if present
    if (req.file) {
        updates.image = `/media/${req.file.filename}`;
    }

    try {
        const vendorProfile = await prisma.vendorProfile.update({
            where: { userId: req.user.id },
            data: updates
        });

        // Also update User role effectively if onboarding is done
        if (updates.onboarding_completed) {
             await prisma.user.update({
                where: { id: req.user.id },
                data: { role: 'vendor' }
            });
        }

        // Return with 'user' field as ID for frontend compatibility (onboardingAPI expects .user to be ID)
        res.json({ ...vendorProfile, user: vendorProfile.userId });
    } catch (error) {
        console.error(error);
        if (error.code === 'P2025') {
             // Profile doesn't exist, maybe try create?
             // Or return 404
             return res.status(404).json({ message: 'Vendor profile not found. Please Create first.' });
        }
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Create vendor profile
// @route   POST /accounts/vendor/profile/
// @access  Private
export const createVendorProfile = async (req, res) => {
     // Identical to Update but uses create
    const { 
        business_name, business_type, description,
        phone, alternate_phone, email,
        owner_name, date_of_birth,
        address, street, area, city, state, pincode, landmark,
        latitude, longitude,
        gst_number, has_gst, tax_type,
        operating_hours, breaks, holidays
    } = req.body;

    const data = { 
        userId: req.user.id,
        business_name, business_type, description,
        phone, alternate_phone, email,
        owner_name, date_of_birth,
        address, street, area, city, state, pincode, landmark,
        latitude, longitude,
        gst_number, has_gst, tax_type,
        operating_hours, breaks, holidays,
        onboarding_completed: true // Default to true on explicit create
    };

    if (req.file) {
        data.image = `/media/${req.file.filename}`;
    }

    try {
         const existingProfile = await prisma.vendorProfile.findUnique({
            where: { userId: req.user.id }
        });

        if (existingProfile) {
            // Forward to Update Logic if exists
            // Or return error
            return res.status(400).json({ message: 'Vendor profile already exists' });
        }

        const vendorProfile = await prisma.vendorProfile.create({
            data: data
        });
        
        await prisma.user.update({
            where: { id: req.user.id },
            data: { role: 'vendor' }
        });

        res.status(201).json({ ...vendorProfile, user: vendorProfile.userId });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};
