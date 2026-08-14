import express from 'express';
import { authAdmin, authorizeAdmin } from '../../middleware/authAdminMiddleware.js';
import {
  listWalkInJobsAdmin,
  getWalkInJobAdmin,
  getWalkInAdoption,
} from '../../controllers/Admin/walkInJobController.js';

const router = express.Router();

router.get('/walk-in-jobs/adoption', authAdmin, authorizeAdmin, getWalkInAdoption);
router.get('/walk-in-jobs/:id', authAdmin, authorizeAdmin, getWalkInJobAdmin);
router.get('/walk-in-jobs', authAdmin, authorizeAdmin, listWalkInJobsAdmin);

export default router;
