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
