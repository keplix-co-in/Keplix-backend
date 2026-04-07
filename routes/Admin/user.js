import express from 'express';
import { authAdmin, authorizeAdmin } from '../../middleware/authAdminMiddleware.js';
import { getUsersData } from '../../controllers/Admin/userController.js';
const router = express.Router();

router.get("/users", authAdmin, authorizeAdmin, getUsersData)



export default router;