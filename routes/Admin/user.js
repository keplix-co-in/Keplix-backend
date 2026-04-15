import express from 'express';
import { authAdmin, authorizeAdmin } from '../../middleware/authAdminMiddleware.js';
import { getUserMetrics, getUsers, deleteUser } from '../../controllers/Admin/userController.js';
const router = express.Router();

router.get("/users/metrics", authAdmin, authorizeAdmin, getUserMetrics);
router.get("/users", authAdmin, authorizeAdmin, getUsers);
router.delete("/users/:id", authAdmin, authorizeAdmin, deleteUser);




export default router;