import express from 'express';
import { getVendorServices, createService, updateService, deleteService } from '../../controllers/vendor/serviceController.js';
import { protect } from '../../middleware/authMiddleware.js';
import {uploadSingle} from '../../middleware/uploadMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createServiceSchema, updateServiceSchema } from '../../validators/vendor/serviceValidators.js';

const router = express.Router();

/**
 * @swagger
 * /service_api/vendor/{vendorId}/services:
 *   get:
 *     summary: Get all services for a specific vendor
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: vendorId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the vendor
 *     responses:
 *       200:
 *         description: List of vendor services
 *       404:
 *         description: Vendor not found
 */
router.get('/:vendorId/services', protect, getVendorServices);

/**
 * @swagger
 * /service_api/vendor/{vendorId}/services/create:
 *   post:
 *     summary: Create a new service for a vendor
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: vendorId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - description
 *               - price
 *               - duration
 *               - category
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               price:
 *                 type: number
 *               duration:
 *                 type: integer
 *               category:
 *                 type: string
 *               image:
 *                 type: string
 *                 format: binary
 *               is_active:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Service created successfully
 */
router.post('/:vendorId/services/create', protect, uploadSingle('image'), validateRequest(createServiceSchema), createService);

/**
 * @swagger
 * /service_api/vendor/{vendorId}/services/update/{id}:
 *   put:
 *     summary: Update an existing service
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: vendorId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Service ID
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               price:
 *                 type: number
 *               duration:
 *                 type: integer
 *               category:
 *                 type: string
 *               image:
 *                 type: string
 *                 format: binary
 *               is_active:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Service updated successfully
 */
router.put('/:vendorId/services/update/:id', protect,uploadSingle('image'),  validateRequest(updateServiceSchema), updateService);

/**
 * @swagger
 * /service_api/vendor/{vendorId}/services/delete/{id}:
 *   delete:
 *     summary: Delete a service
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: vendorId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Service deleted successfully
 */
router.delete('/:vendorId/services/delete/:id', protect, deleteService);

export default router;
