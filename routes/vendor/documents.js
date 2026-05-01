import express from 'express';
import { getDocuments, uploadDocument } from '../../controllers/vendor/documentController.js';
import { protect } from '../../middleware/authMiddleware.js';
import {uploadSingle} from '../../middleware/uploadMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { uploadDocumentSchema } from '../../validators/vendor/documentValidators.js';

const router = express.Router();

/**
 * @swagger
 * /accounts/documents:
 *   get:
 *     summary: Get vendor documents
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of vendor documents
 */
router.get('/', protect, getDocuments);

/**
 * @swagger
 * /accounts/documents:
 *   post:
 *     summary: Upload a new vendor document
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - document_type
 *               - file_url
 *             properties:
 *               document_type:
 *                 type: string
 *               file_url:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: Document uploaded successfully
 */
router.post('/', protect, uploadSingle('file_url'), validateRequest(uploadDocumentSchema), uploadDocument);

export default router;
