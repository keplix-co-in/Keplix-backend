import express from 'express';
import { getJobSheetByToken } from '../../controllers/public/jobSheetController.js';
import { publicJobLookupLimiter } from '../../middleware/rateLimitMiddleware.js';

const router = express.Router();

/**
 * @swagger
 * /content/job-sheet/{token}:
 *   get:
 *     summary: Public, unauthenticated lookup of a walk-in job / booking health sheet by tracking token
 *     tags: [Public - Job Sheet]
 */
router.get('/job-sheet/:token', publicJobLookupLimiter, getJobSheetByToken);

export default router;
