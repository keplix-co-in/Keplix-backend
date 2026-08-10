import express from "express";
import {
  listPublishedPosts,
  getPublishedPostBySlug,
} from "../../controllers/public/blogController.js";

const router = express.Router();

/**
 * @swagger
 * /content/blog/posts:
 *   get:
 *     summary: List published blog posts (public, no auth)
 *     tags: [Public - Blog]
 */
router.get("/blog/posts", listPublishedPosts);

router.get("/blog/posts/:slug", getPublishedPostBySlug);

export default router;
