
import prisma from "../../util/prisma.js";
import { setupVendorPayoutAccount, updateVendorPayoutAccount } from "../../util/payoutHelper.js";
import Logger from "../../util/logger.js";

/**
 * Reports whether a vendor can actually be paid out.
 *
 * Payouts hard-fail without an active VendorPayoutAccount
 * (util/payoutHelper.js throws "Vendor payout account not found or inactive"),
 * and nothing in the apps or the admin panel used to show that state — so the
 * first symptom was a failed settlement long after onboarding. Exposing it on
 * the profile lets the vendor app prompt for bank details instead.
 */
export const describePayoutAccount = async (vendorId) => {
    const account = await prisma.vendorPayoutAccount.findUnique({ where: { vendorId } });
    if (!account) return { ok: false, configured: false, reason: 'no_payout_account' };
    if (!account.isActive) return { ok: false, configured: false, reason: 'payout_account_inactive' };
    return { ok: true, configured: true };
};



/**
 * Get vendor profile with aggregated stats (total orders, earnings, avg rating).
 * Stats are computed via DB-level COUNT/SUM/AVG instead of loading all rows into memory.
 *
 * @param {Object} req - Express request object
 * @param {string} req.user.id - Authenticated vendor's user ID
 * @param {Object} res - Express response object
 * @returns {Object} Vendor profile merged with { rating, total_orders, total_earnings }
 */
export const getVendorProfile = async (req, res) => {
    try {
        const vendorProfile = await prisma.vendorProfile.findUnique({
            where: { userId: req.user.id },
            include: { user: true }
        });

        if (!vendorProfile) {
            return res.status(404).json({ message: 'Vendor profile not found' });
        }

        const vendorId = req.user.id;

        // total_orders / total_earnings still require scanning bookings+payments
        // (no running counters exist for those yet). rating/numReviews are
        // maintained incrementally on VendorProfile (see util/ratingHelper.js),
        // so they're read directly instead of re-aggregated on every request.
        const [orderCount, earningsResult] = await Promise.all([
            // COUNT bookings with active statuses for this vendor's services
            prisma.booking.count({
                where: {
                    service: { vendorId },
                    status: { in: ['completed', 'confirmed', 'ongoing'] }
                }
            }),

            // SUM vendorAmount from successful payments on this vendor's bookings
            prisma.payment.aggregate({
                where: {
                    status: 'success',
                    booking: {
                        service: { vendorId },
                        status: { in: ['completed', 'confirmed', 'ongoing'] }
                    }
                },
                _sum: { vendorAmount: true, amount: true }
            })
        ]);

        const total_orders = orderCount;
        const total_earnings = parseFloat(earningsResult._sum.vendorAmount ?? earningsResult._sum.amount ?? 0);

        // Surfaced so the vendor app can prompt for bank details when payouts
        // aren't set up, instead of the vendor discovering it when a
        // settlement fails weeks later.
        const payoutSetup = await describePayoutAccount(vendorId);

        res.json({
            ...vendorProfile,
            rating: Number(vendorProfile.rating ?? 0).toFixed(1),
            total_orders,
            total_earnings: total_earnings.toFixed(2),
            payoutSetup
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

/**
 * Update an existing vendor profile with partial fields, image uploads, and address auto-combination.
 * Falls back to createVendorProfile if the profile doesn't exist yet (P2025 error).
 * Also triggers payout account update if bank/UPI details change.
 *
 * @param {Object} req - Express request object
 * @param {string} req.user.id - Authenticated vendor's user ID
 * @param {Object} req.body - Partial vendor profile fields to update (business_name, phone, address components, bank details, etc.)
 * @param {Object} [req.files] - Multer file uploads ({ image: [...], cover_image: [...] })
 * @param {Object} res - Express response object
 * @returns {Object} Updated vendor profile with userId mapped to .user for frontend compatibility
 */
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
        const imageFiles = req.files.image || req.files['image'];
        if (imageFiles && imageFiles.length > 0) {
            updates.image = imageFiles[0].path;
        }

        const coverFiles = req.files.cover_image || req.files['cover_image'];
        if (coverFiles && coverFiles.length > 0) {
            updates.cover_image = coverFiles[0].path;
        }
    } else if (req.file) {
        updates.image = req.file.path;
    }

    try {
        const vendorProfile = await prisma.$transaction(async (tx) => {
            const profile = await tx.vendorProfile.update({
                where: { userId: req.user.id },
                data: updates
            });

            // Also update User role effectively if onboarding is done
            if (updates.onboarding_completed) {
                await tx.user.update({
                    where: { id: req.user.id },
                    data: { role: 'vendor' }
                });
            }

            return profile;
        });

        // Setup or update payout account if bank/UPI details were provided.
        //
        // A failure here is NOT fatal to the profile update — a RazorpayX
        // outage shouldn't discard the vendor's photos, address and documents.
        // But it must not be invisible either, which is what it used to be:
        // the error went to console.error (which never reaches logs/error.log)
        // and the response was a plain success, so the vendor believed they
        // were onboarded and nobody found out until a payout failed days
        // later. The outcome is now logged properly AND reported in the
        // response so the client can tell the vendor to fix it.
        let payoutSetup = { ok: true, configured: true };
        if ((updates.bank_account_number !== undefined && updates.ifsc_code !== undefined) ||
            updates.upi_id !== undefined) {
            try {
                await updateVendorPayoutAccount(req.user.id, vendorProfile);
            } catch (payoutError) {
                Logger.error(
                    `[VendorProfile] Payout account setup FAILED for vendor ${req.user.id}: ${payoutError.message}. ` +
                    `Profile was saved, but this vendor cannot be paid out until it is fixed.`
                );
                payoutSetup = { ok: false, configured: false, error: payoutError.message };
            }
        } else {
            payoutSetup = await describePayoutAccount(req.user.id);
        }

        // Return with 'user' field as ID for frontend compatibility (onboardingAPI expects .user to be ID)
        res.json({ ...vendorProfile, user: vendorProfile.userId, payoutSetup });
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

/**
 * Create a new vendor profile during onboarding. Sets user role to 'vendor' and optionally sets up payout account.
 * Returns 400 if a profile already exists for this user.
 *
 * @param {Object} req - Express request object
 * @param {string} req.user.id - Authenticated user's ID
 * @param {Object} req.body - Vendor profile fields (business_name, business_type, description, phone, address components, GST, bank details, etc.)
 * @param {Object} [req.files] - Multer file uploads ({ image: [...], cover_image: [...] })
 * @param {Object} res - Express response object
 * @returns {Object} Created vendor profile (201) with userId mapped to .user
 */
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
        bank_account_number, ifsc_code, upi_id
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

        // Setup payout account if bank/UPI details were provided. Same
        // reasoning as the update path above: non-fatal, but never silent.
        let payoutSetup = { ok: true, configured: false, reason: 'no_bank_details_supplied' };
        if ((data.bank_account_number && data.ifsc_code) || data.upi_id) {
            try {
                await setupVendorPayoutAccount(req.user.id, vendorProfile);
                payoutSetup = { ok: true, configured: true };
            } catch (payoutError) {
                Logger.error(
                    `[VendorProfile] Payout account setup FAILED for vendor ${req.user.id}: ${payoutError.message}. ` +
                    `Profile was created, but this vendor cannot be paid out until it is fixed.`
                );
                payoutSetup = { ok: false, configured: false, error: payoutError.message };
            }
        }

        res.status(201).json({ ...vendorProfile, user: vendorProfile.userId, payoutSetup });
    } catch (error) {
        console.error("Create Vendor Profile Error:", error); // Added detailed logging
        res.status(500).json({ message: 'Server Error', error: error.message }); // Return error details for debugging
    }
};

/**
 * Toggle vendor's online/offline status. Expects a boolean is_online in the request body.
 *
 * @param {Object} req - Express request object
 * @param {string} req.user.id - Authenticated vendor's user ID
 * @param {boolean} req.body.is_online - New online status (true = online, false = offline)
 * @param {Object} res - Express response object
 * @returns {Object} { message, is_online }
 */
export const updateOnlineStatus = async (req, res) => {
    try {
        const { is_online } = req.body;

        if (typeof is_online !== 'boolean') {
            return res.status(400).json({ message: 'is_online must be a boolean' });
        }

        const updatedProfile = await prisma.vendorProfile.update({
            where: { userId: req.user.id },
            data: { is_online }
        });

        res.json({ message: 'Online status updated', is_online: updatedProfile.is_online });
    } catch (error) {
        console.error("Update Online Status Error:", error);
        res.status(500).json({ message: 'Server Error' });
    }
};




