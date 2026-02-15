

import { PrismaClient } from "@prisma/client";
import { setupVendorPayoutAccount, updateVendorPayoutAccount } from "../../util/payoutHelper.js";

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
    let { 
        business_name, business_type, description,
        phone, alternate_phone, email,
        owner_name, date_of_birth,
        address, street, area, city, state, pincode, landmark,
        latitude, longitude,
        gst_number, has_gst, tax_type,
        operating_hours, breaks, holidays,
        bank_account_number, ifsc_code, upi_id,
        onboarding_completed // if sent by frontend
    } = req.body;

    // Validate JSON strings for breaks/holidays but keep them as strings for Prisma
    if (typeof breaks === 'string' && breaks) {
        try {
            JSON.parse(breaks); // Validate it's valid JSON
            // Keep as string - Prisma schema expects String type
        } catch (e) {
            console.warn('[VendorProfile] Invalid JSON for breaks:', breaks);
            breaks = null;
        }
    }
    
    if (typeof holidays === 'string' && holidays) {
        try {
            JSON.parse(holidays); // Validate it's valid JSON
            // Keep as string - Prisma schema expects String type
        } catch (e) {
            console.warn('[VendorProfile] Invalid JSON for holidays:', holidays);
            holidays = null;
        }
    }

    // Build updates object - only include defined values
    const updates = {};
    
    if (business_name !== undefined) updates.business_name = business_name;
    if (business_type !== undefined) updates.business_type = business_type;
    if (description !== undefined) updates.description = description;
    if (phone !== undefined) updates.phone = phone;
    if (alternate_phone !== undefined) updates.alternate_phone = alternate_phone;
    if (email !== undefined) updates.email = email;
    if (owner_name !== undefined) updates.owner_name = owner_name;
    if (date_of_birth !== undefined) updates.date_of_birth = date_of_birth;
    if (address !== undefined) updates.address = address;
    if (street !== undefined) updates.street = street;
    if (area !== undefined) updates.area = area;
    if (city !== undefined) updates.city = city;
    if (state !== undefined) updates.state = state;
    if (pincode !== undefined) updates.pincode = pincode;
    if (landmark !== undefined) updates.landmark = landmark;
    if (latitude !== undefined) updates.latitude = latitude;
    if (longitude !== undefined) updates.longitude = longitude;
    if (gst_number !== undefined) updates.gst_number = gst_number;
    if (has_gst !== undefined) updates.has_gst = has_gst;
    if (tax_type !== undefined) updates.tax_type = tax_type;
    if (operating_hours !== undefined) updates.operating_hours = operating_hours;
    if (breaks !== undefined && breaks !== null) updates.breaks = breaks;
    if (holidays !== undefined && holidays !== null) updates.holidays = holidays;
    if (bank_account_number !== undefined) updates.bank_account_number = bank_account_number;
    if (ifsc_code !== undefined) updates.ifsc_code = ifsc_code;
    if (upi_id !== undefined) updates.upi_id = upi_id;
    // If any address components were updated, also update the combined address field
    const addressComponents = [street, area, city, state, pincode].filter(val => val !== undefined && val !== null && val !== '');
    if (addressComponents.length > 0) {
        // Get current profile to combine with existing address components
        const currentProfile = await prisma.vendorProfile.findUnique({
            where: { userId: req.user.id },
            select: { street: true, area: true, city: true, state: true, pincode: true, address: true }
        });
        
        if (currentProfile) {
            const combinedAddress = [
                updates.street !== undefined ? updates.street : currentProfile.street,
                updates.area !== undefined ? updates.area : currentProfile.area, 
                updates.city !== undefined ? updates.city : currentProfile.city,
                updates.state !== undefined ? updates.state : currentProfile.state,
                updates.pincode !== undefined ? updates.pincode : currentProfile.pincode
            ].filter(Boolean).join(', ');
            
            if (combinedAddress.trim()) {
                updates.address = combinedAddress;
            }
        }
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

        // Setup or update payout account if bank/UPI details were provided
        if ((updates.bank_account_number !== undefined && updates.ifsc_code !== undefined) ||
            updates.upi_id !== undefined) {
            try {
                await updateVendorPayoutAccount(req.user.id, vendorProfile);
                console.log('[VendorProfile] Payout account updated for vendor:', req.user.id);
            } catch (payoutError) {
                console.error('[VendorProfile] Failed to setup payout account:', payoutError);
                // Don't fail the profile update if payout setup fails
            }
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
        operating_hours, breaks, holidays,
        bank_account_number, ifsc_code
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
        bank_account_number,
        ifsc_code,
        upi_id,
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

        // Setup payout account if bank/UPI details were provided
        if ((data.bank_account_number && data.ifsc_code) || data.upi_id) {
            try {
                await setupVendorPayoutAccount(req.user.id, vendorProfile);
                console.log('[VendorProfile] Payout account created for vendor:', req.user.id);
            } catch (payoutError) {
                console.error('[VendorProfile] Failed to setup payout account:', payoutError);
                // Don't fail the profile creation if payout setup fails
            }
        }

        res.status(201).json({ ...vendorProfile, user: vendorProfile.userId });
    } catch (error) {
        console.error("Create Vendor Profile Error:", error); // Added detailed logging
        res.status(500).json({ message: 'Server Error', error: error.message }); // Return error details for debugging
    }
};
