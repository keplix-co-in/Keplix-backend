import express from 'express';
import { login }from '../../controllers/admin/authController.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { loginSchema } from '../../validators/admin/authAdminValidator.js';
const router = express.Router();


router.post("/login", validateRequest(loginSchema), login);


export default router;