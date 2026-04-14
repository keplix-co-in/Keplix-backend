import express from 'express';
import { getDashboardMetrics , getDashboardDetails } from '../../controllers/Admin/dashBoardController.js';
import {authAdmin, authorizeAdmin} from '../../middleware/authAdminMiddleware.js';
const router = express.Router();

router.get("/dashboard/metrics", authAdmin, authorizeAdmin, getDashboardMetrics);
router.get("/dashboard/revenue", authAdmin, authorizeAdmin, getDashboardDetails);

export default router;