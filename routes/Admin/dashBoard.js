import express from 'express';
import { getDashboardMetrics , getDashboardDetails } from '../../controllers/Admin/dashBoardController.js';
import {authAdmin, authorizeAdmin} from '../../middleware/authAdminMiddleware.js';
const router = express.Router();

<<<<<<< HEAD
router.get("/dashboard/metrics", authAdmin, authorizeAdmin, getDashboardMetrics);
=======
/**
 * @swagger
 * /admin/dashboard/metrics:
 *   get:
 *     summary: Get dashboard metrics
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard metrics retrieved successfully
 */
router.get("/dashboard/metrics", authAdmin, authorizeAdmin, getDashboardMetrics);

/**
 * @swagger
 * /admin/dashboard/revenue:
 *   get:
 *     summary: Get dashboard revenue details
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard revenue details retrieved successfully
 */
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
router.get("/dashboard/revenue", authAdmin, authorizeAdmin, getDashboardDetails);

export default router;