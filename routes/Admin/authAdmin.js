import express from 'express';
import { login, resetPassword }from '../../controllers/Admin/authController.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { loginSchema } from '../../validators/Admin/authAdminValidator.js';
const router = express.Router();


router.post("/login", validateRequest(loginSchema), login);
router.post("/reset-passsword/:id/:token", resetPassword); 

export default router;