import prisma from "../util/prisma.js";
// @desc    Role-based permissions
// @access  Protected

// Check if user is a Vendor
export const vendorOnly = (req, res, next) => {
    if (req.user && req.user.role === 'vendor') {
        next();
    } else {
        res.status(403);
        throw new Error('Not authorized as a vendor');
    }
};

// Check if user is an Admin
export const adminOnly = (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403);
        throw new Error('Not authorized as an admin');
    }
};

// Check if user is active
export const activeOnly = (req, res, next) => {
    if (req.user && req.user.is_active) {
        next();
    } else {
        res.status(403);
        throw new Error('User account is inactive. Please contact support.');
    }
};

// Security A-020 / SYS-003: money and job actions (accepting/updating
// bookings, walk-in jobs, health sheets, vendor payments) need an
// admin-APPROVED vendor. Onboarding, profile, documents, services and all
// read routes stay open to pending vendors so they can finish signing up.
// Must run after protect + vendorOnly.
export const requireApprovedVendor = async (req, res, next) => {
    try {
        const vp = await prisma.vendorProfile.findUnique({
            where: { userId: req.user.id },
            select: { status: true },
        });
        if (vp?.status === 'approved') return next();
        return res.status(403).json({
            success: false,
            code: 'VENDOR_NOT_APPROVED',
            message: 'Your vendor account is awaiting approval.',
        });
    } catch (err) {
        return next(err);
    }
};
