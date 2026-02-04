
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
            // Calculate dynamic statistics
            const vendorId = req.user.id;
            
            // 1. Get all services by this vendor
            const services = await prisma.service.findMany({
                where: { vendorId },
                select: { id: true }
            });
            const serviceIds = services.map(s => s.id);
            
            // 2. Get all bookings for vendor's services
            const bookings = await prisma.booking.findMany({
                where: { 
                    serviceId: { in: serviceIds },
                    status: { in: ['completed', 'confirmed', 'ongoing'] }
                },
                include: { 
                    payment: true,
                    review: true 
                }
            });
            
            // 3. Calculate total orders
            const total_orders = bookings.length;
            
            // 4. Calculate total earnings from completed payments
            const total_earnings = bookings.reduce((sum, booking) => {
                if (booking.payment && booking.payment.status === 'success') {
                    return sum + parseFloat(booking.payment.vendorAmount || booking.payment.amount || 0);
                }
                return sum;
            }, 0);
            
            // 5. Calculate average rating from reviews
            const reviews = bookings.filter(b => b.review).map(b => b.review);
            const average_rating = reviews.length > 0 
                ? (reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length).toFixed(1)
                : "0.0";
            
            // Return profile with calculated stats
            res.json({
                ...vendorProfile,
                rating: average_rating,
                total_orders,
                total_earnings: total_earnings.toFixed(2)
            });
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

    // Handle Image uploads
    if (req.files) {
        console.log('[VendorProfile] Files Object Keys:', Object.keys(req.files));
        
        // Handle 'image' -> Owner Selfie
        const imageFiles = req.files.image || req.files['image'];
        if (imageFiles && imageFiles.length > 0) {
            updates.image = imageFiles[0].path; 
            console.log('-> SET: Owner Image URL:', updates.image);
        }

        // Handle 'cover_image' -> Workshop Photo
        const coverFiles = req.files.cover_image || req.files['cover_image'];
        if (coverFiles && coverFiles.length > 0) {
            updates.cover_image = coverFiles[0].path;
            console.log('-> SET: Workshop Image URL:', updates.cover_image);
        } else {
             console.log('-> SKIP: No cover_image file found in req.files');
        }
    } else if (req.file) {
        // Fallback for single file upload
        updates.image = req.file.path;
        console.log('-> SET: Fallback single file to image');
    }

    console.log('[VendorProfile] Final Updates Object:', JSON.stringify(updates, null, 2));

    console.log('[VendorProfile] Update Request:', { userId: req.user.id, updates });

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
             // Profile doesn't exist.
             // Auto-create: Since this is likely onboarding trying to "Update" a profile that isn't made yet.
             return createVendorProfile(req, res);
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
        business_name, 
        business_type, 
        description,
        phone, 
        alternate_phone, 
        email,
        owner_name, 
        date_of_birth,
        address, 
        street, 
        area, 
        city, 
        state, 
        pincode, 
        landmark,
        // Convert to float/int if they exist, otherwise undefined
        latitude: latitude ? parseFloat(latitude) : undefined, 
        longitude: longitude ? parseFloat(longitude) : undefined,
        gst_number, 
        // Boolean conversion if string "true"/"false" comes from FormData
        has_gst: has_gst === 'true' || has_gst === true, 
        tax_type,
        operating_hours, 
        breaks, 
        holidays,
        onboarding_completed: true 
    };

    // Handle Image uploads (fields: image, cover_image)
    if (req.files) {
        if (req.files.image && req.files.image[0]) {
            data.image = req.files.image[0].path; 
        }
        if (req.files.cover_image && req.files.cover_image[0]) {
            data.cover_image = req.files.cover_image[0].path;
        }
    } else if (req.file) {
        data.image = req.file.path; 
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
        console.error("Create Vendor Profile Error:", error); // Added detailed logging
        res.status(500).json({ message: 'Server Error', error: error.message }); // Return error details for debugging
    }
};
