import express from 'express';
import { getAllServices, getServiceById, getServiceCategories, searchVendorsByLocation, getServicesByVendor, getFeaturedServices } from '../../controllers/user/serviceController.js';

const router = express.Router();

/**
 * @swagger
 * /service_api/user/services:
 *   get:
 *     summary: Get all services
 *     tags: [User]
 *     responses:
 *       200:
 *         description: List of all services
 */
router.get('/services', getAllServices);

/**
 * @swagger
 * /service_api/user/services/featured:
 *   get:
 *     summary: Get featured services
 *     tags: [User]
 *     responses:
 *       200:
 *         description: List of featured services
 */
router.get('/services/featured', getFeaturedServices);

/**
 * @swagger
 * /service_api/user/services/{id}:
 *   get:
 *     summary: Get service by ID
 *     tags: [User]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Service details
 */
router.get('/services/:id', getServiceById);

/**
 * @swagger
 * /service_api/user/categories:
 *   get:
 *     summary: Get service categories
 *     tags: [User]
 *     responses:
 *       200:
 *         description: List of categories
 */
router.get('/categories', getServiceCategories);

/**
 * @swagger
 * /service_api/user/search:
 *   get:
 *     summary: Search vendors by location
 *     tags: [User]
 *     parameters:
 *       - in: query
 *         name: lat
 *         schema:
 *           type: number
 *       - in: query
 *         name: lng
 *         schema:
 *           type: number
 *     responses:
 *       200:
 *         description: Search results
 */
router.get('/search', searchVendorsByLocation);

/**
 * @swagger
 * /service_api/user/vendors/{vendorId}/services:
 *   get:
 *     summary: Get services by vendor
 *     tags: [User]
 *     parameters:
 *       - in: path
 *         name: vendorId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of services for the vendor
 */
router.get('/vendors/:vendorId/services', getServicesByVendor);

export default router;
