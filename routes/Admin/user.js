import express from 'express';
import { authAdmin, authorizeAdmin } from '../../middleware/authAdminMiddleware.js';
import { getUserMetrics, getUsers, deleteUser } from '../../controllers/Admin/userController.js';
const router = express.Router();

/**
 * @swagger
 * /admin/users/metrics:
 *   get:
 *     summary: Get user metrics
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User metrics retrieved successfully
 */
router.get("/users/metrics", authAdmin, authorizeAdmin, getUserMetrics);

/**
 * @swagger
 * /admin/users:
 *   get:
 *     summary: Get all users
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Users retrieved successfully
 */
router.get("/users", authAdmin, authorizeAdmin, getUsers);

/**
 * @swagger
 * /admin/users/{id}:
 *   delete:
 *     summary: Delete a user
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User deleted successfully
 */
router.delete("/users/:id", authAdmin, authorizeAdmin, deleteUser);




export default router;