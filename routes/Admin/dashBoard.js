import express from 'express';
import { getDashboardData , getDashBoardRevenue } from '../../controllers/admin/dashBoardController.js';
import {authAdmin, authorizeAdmin} from '../../middleware/authAdminMiddleware.js';
const router = express.Router();

router.get("/dashboard/metrics", authAdmin, authorizeAdmin, getDashboardData);
router.get("/dashboard/revenue", authAdmin, authorizeAdmin, getDashBoardRevenue);

export default router;