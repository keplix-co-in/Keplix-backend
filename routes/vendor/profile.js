import express from 'express';
import { getVendorProfile, updateVendorProfile, createVendorProfile, updateOnlineStatus } from '../../controllers/vendor/profileController.js';
import { protect } from '../../middleware/authMiddleware.js';
import {uploadSingle, uploadFieldss} from '../../middleware/uploadMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createVendorProfileSchema, updateVendorProfileSchema } from '../../validators/vendor/profileValidators.js';

const router = express.Router();

/**
 * @swagger
 * /accounts/vendor:
 *   get:
 *     summary: Get vendor profile
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Vendor profile retrieved successfully
 *       404:
 *         description: Vendor profile not found
 */
router.get('/', protect, getVendorProfile);

// Add upload middleware to handle FormData (image + text fields)
const uploadFields = uploadFieldss([
    { name: 'image', maxCount: 1 },
    { name: 'cover_image', maxCount: 1 }
]);

/**
 * @swagger
 * /accounts/vendor:
 *   put:
 *     summary: Update vendor profile
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               business_name:
 *                 type: string
 *               business_type:
 *                 type: string
 *               description:
 *                 type: string
 *               phone:
 *                 type: string
 *               alternate_phone:
 *                 type: string
 *               email:
 *                 type: string
 *               owner_name:
 *                 type: string
 *               date_of_birth:
 *                 type: string
 *               address:
 *                 type: string
 *               street:
 *                 type: string
 *               area:
 *                 type: string
 *               city:
 *                 type: string
 *               state:
 *                 type: string
 *               pincode:
 *                 type: string
 *               landmark:
 *                 type: string
 *               latitude:
 *                 type: number
 *               longitude:
 *                 type: number
 *               gst_number:
 *                 type: string
 *               has_gst:
 *                 type: boolean
 *               tax_type:
 *                 type: string
 *               operating_hours:
 *                 type: string
 *               breaks:
 *                 type: string
 *               holidays:
 *                 type: string
 *               bank_account_number:
 *                 type: string
 *               ifsc_code:
 *                 type: string
 *               upi_id:
 *                 type: string
 *               image:
 *                 type: string
 *                 format: binary
 *               cover_image:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Vendor profile updated successfully
 *       404:
 *         description: Profile not found (will auto-create)
 */
router.put('/', protect, uploadFields, validateRequest(updateVendorProfileSchema), updateVendorProfile);

/**
 * @swagger
 * /accounts/vendor:
 *   patch:
 *     summary: Update vendor profile (partial)
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               business_name:
 *                 type: string
 *               business_type:
 *                 type: string
 *               description:
 *                 type: string
 *               phone:
 *                 type: string
 *               alternate_phone:
 *                 type: string
 *               email:
 *                 type: string
 *               owner_name:
 *                 type: string
 *               date_of_birth:
 *                 type: string
 *               address:
 *                 type: string
 *               street:
 *                 type: string
 *               area:
 *                 type: string
 *               city:
 *                 type: string
 *               state:
 *                 type: string
 *               pincode:
 *                 type: string
 *               landmark:
 *                 type: string
 *               latitude:
 *                 type: number
 *               longitude:
 *                 type: number
 *               gst_number:
 *                 type: string
 *               has_gst:
 *                 type: boolean
 *               tax_type:
 *                 type: string
 *               operating_hours:
 *                 type: string
 *               breaks:
 *                 type: string
 *               holidays:
 *                 type: string
 *               bank_account_number:
 *                 type: string
 *               ifsc_code:
 *                 type: string
 *               upi_id:
 *                 type: string
 *               image:
 *                 type: string
 *                 format: binary
 *               cover_image:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Vendor profile updated successfully
 */
router.patch('/', protect, uploadFields, validateRequest(updateVendorProfileSchema), updateVendorProfile);

/**
 * @swagger
 * /accounts/vendor/online-status:
 *   patch:
 *     summary: Update vendor online status
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               is_online:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Online status updated successfully
 */
router.patch('/online-status', protect, updateOnlineStatus);

/**
 * @swagger
 * /accounts/vendor:
 *   post:
 *     summary: Create vendor profile
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - business_name
 *               - phone
 *             properties:
 *               business_name:
 *                 type: string
 *               phone:
 *                 type: string
 *               business_type:
 *                 type: string
 *               description:
 *                 type: string
 *               alternate_phone:
 *                 type: string
 *               email:
 *                 type: string
 *               owner_name:
 *                 type: string
 *               date_of_birth:
 *                 type: string
 *               address:
 *                 type: string
 *               street:
 *                 type: string
 *               area:
 *                 type: string
 *               city:
 *                 type: string
 *               state:
 *                 type: string
 *               pincode:
 *                 type: string
 *               landmark:
 *                 type: string
 *               latitude:
 *                 type: number
 *               longitude:
 *                 type: number
 *               gst_number:
 *                 type: string
 *               has_gst:
 *                 type: boolean
 *               tax_type:
 *                 type: string
 *               operating_hours:
 *                 type: string
 *               breaks:
 *                 type: string
 *               holidays:
 *                 type: string
 *               bank_account_number:
 *                 type: string
 *               ifsc_code:
 *                 type: string
 *               upi_id:
 *                 type: string
 *               image:
 *                 type: string
 *                 format: binary
 *               cover_image:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: Vendor profile created successfully
 *       400:
 *         description: Profile already exists
 */
router.post('/', protect, uploadFields, validateRequest(createVendorProfileSchema), createVendorProfile);

// Trailing slash support
router.get('/profile/', protect, getVendorProfile);
router.put('/profile/', protect, uploadFields, validateRequest(updateVendorProfileSchema), updateVendorProfile);
router.patch('/profile/', protect, uploadFields, validateRequest(updateVendorProfileSchema), updateVendorProfile);
router.post('/profile/', protect, uploadFields, validateRequest(createVendorProfileSchema), createVendorProfile);


export default router;
