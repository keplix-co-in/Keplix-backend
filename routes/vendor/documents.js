import express from 'express';
import { getDocuments, uploadDocument } from '../../controllers/vendor/documentController.js';
import { protect } from '../../middleware/authMiddleware.js';
import upload from '../../middleware/uploadMiddleware.js';

const router = express.Router();

router.get('/', protect, getDocuments);
router.post('/', protect, upload.single('file'), uploadDocument);

export default router;
