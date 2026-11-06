import { clampLimit } from "../../util/parsePagination.js"; // Security A-026: list limits capped at 100
import prisma from "../../util/prisma.js";

/** Fields safe to expose publicly — never leak draft content or author emails. */
const PUBLIC_SELECT = {
  id: true,
  slug: true,
  title: true,
  excerpt: true,
  coverImage: true,
  category: true,
  readTime: true,
  publishedAt: true,
  // Exposed so the website can emit BlogPosting `dateModified` and an accurate
  // sitemap <lastmod> for posts edited after publishing. Not sensitive.
  updatedAt: true,
  author: { select: { name: true } },
};

export const listPublishedPosts = async (req, res) => {
  try {
    const { page = 1, limit = 24, category } = req.query;
    const skip = (Number(page) - 1) * clampLimit(limit);

    const where = {
      status: "published",
      ...(category && category !== "All" ? { category } : {}),
    };

    const [posts, total] = await Promise.all([
      prisma.blogPost.findMany({
        where,
        orderBy: { publishedAt: "desc" },
        skip: Number(skip),
        take: clampLimit(limit),
        select: PUBLIC_SELECT,
      }),
      prisma.blogPost.count({ where }),
    ]);

    res.json({
      data: posts,
      pagination: {
        total,
        page: Number(page),
        limit: clampLimit(limit),
        totalPages: Math.ceil(total / clampLimit(limit)),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch posts" });
  }
};

export const getPublishedPostBySlug = async (req, res) => {
  try {
    const post = await prisma.blogPost.findFirst({
      // Match on status too, so a draft's slug can't be guessed to read it early.
      where: { slug: req.params.slug, status: "published" },
      select: { ...PUBLIC_SELECT, content: true },
    });

    if (!post) return res.status(404).json({ message: "Post not found" });
    res.json(post);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch post" });
  }
};
