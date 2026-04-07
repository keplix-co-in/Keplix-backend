import express from 'express';
import { login }from '../../controllers/Admin/authController.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { loginSchema } from '../../validators/Admin/authAdminValidator.js';
const router = express.Router();


router.post("/login", validateRequest(loginSchema), login);


export default router;