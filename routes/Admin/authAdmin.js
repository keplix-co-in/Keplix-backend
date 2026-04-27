import express from 'express';
import { login }from '../../controllers/Admin/authController.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { loginSchema } from '../../validators/Admin/authAdminValidator.js';
const router = express.Router();

/**
 * @swagger
 * /admin/auth/login:
 *   post:
 *     summary: Admin login
 *     tags: [Admin]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Admin login successful
 */
router.post("/login", validateRequest(loginSchema), login);


export default router;