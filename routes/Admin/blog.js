import express from "express";
import {
  authAdmin,
  authorizeAdmin,
} from "../../middleware/authAdminMiddleware.js";
import { uploadSingle } from "../../middleware/uploadMiddleware.js";
import { validateRequest } from "../../middleware/validationMiddleware.js";
import {
  createBlogSchema,
  updateBlogSchema,
} from "../../validators/Admin/blogValidator.js";
import {
  getBlogPosts,
  getBlogPost,
  createBlogPost,
  updateBlogPost,
  deleteBlogPost,
} from "../../controllers/Admin/blogController.js";

const router = express.Router();

/**
 * @swagger
 * /admin/blogs:
 *   get:
 *     summary: List blog posts (admin)
 *     tags: [Admin - Blog]
 */
router.get("/blogs", authAdmin, authorizeAdmin, getBlogPosts);

router.get("/blogs/:id", authAdmin, authorizeAdmin, getBlogPost);

// uploadSingle must run before validateRequest: multipart bodies aren't
// parsed until multer has handled the request.
router.post(
  "/blogs",
  authAdmin,
  authorizeAdmin,
  uploadSingle("coverImage"),
  validateRequest(createBlogSchema),
  createBlogPost
);

router.put(
  "/blogs/:id",
  authAdmin,
  authorizeAdmin,
  uploadSingle("coverImage"),
  validateRequest(updateBlogSchema),
  updateBlogPost
);

router.delete("/blogs/:id", authAdmin, authorizeAdmin, deleteBlogPost);

export default router;
