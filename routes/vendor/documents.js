import express from 'express';
import { getDocuments, uploadDocument } from '../../controllers/vendor/documentController.js';
import { protect } from '../../middleware/authMiddleware.js';
import upload from '../../middleware/uploadMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { uploadDocumentSchema } from '../../validators/vendor/documentValidators.js';

const router = express.Router();

router.get('/', protect, getDocuments);
router.post('/', protect, upload.single('file'), validateRequest(uploadDocumentSchema), uploadDocument);

export default router;
