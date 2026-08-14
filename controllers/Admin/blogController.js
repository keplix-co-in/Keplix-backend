import prisma from "../../util/prisma.js";
import { uniqueSlug } from "../../util/slugify.js";
import { sanitizeBlogHtml, estimateReadTime } from "../../util/sanitizeHtml.js";

const AUTHOR_SELECT = { select: { id: true, name: true } };

export const getBlogPosts = async (req, res) => {
  try {
    const { status = "all", page = 1, limit = 10, search = "" } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where = {
      ...(status !== "all" ? { status } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: "insensitive" } },
              { excerpt: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [posts, total] = await Promise.all([
      prisma.blogPost.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: Number(skip),
        take: Number(limit),
        include: { author: AUTHOR_SELECT },
      }),
      prisma.blogPost.count({ where }),
    ]);

    res.json({
      data: posts,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch blog posts" });
  }
};

export const getBlogPost = async (req, res) => {
  try {
    const post = await prisma.blogPost.findUnique({
      where: { id: Number(req.params.id) },
      include: { author: AUTHOR_SELECT },
    });

    if (!post) return res.status(404).json({ message: "Post not found" });
    res.json(post);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch blog post" });
  }
};

export const createBlogPost = async (req, res) => {
  try {
    const { title, excerpt, content, category, status = "draft" } = req.body;

    // An uploaded file wins over a pasted URL.
    const coverImage = req.file?.cloudinary?.secure_url || req.body.coverImage || null;
    const safeContent = sanitizeBlogHtml(content);

    const post = await prisma.blogPost.create({
      data: {
        slug: await uniqueSlug(title),
        title,
        excerpt: excerpt || null,
        content: safeContent,
        coverImage,
        category: category || "General",
        readTime: estimateReadTime(safeContent),
        status,
        publishedAt: status === "published" ? new Date() : null,
        authorId: req.user?.id ?? null,
      },
      include: { author: AUTHOR_SELECT },
    });

    res.status(201).json(post);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to create blog post" });
  }
};

export const updateBlogPost = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.blogPost.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Post not found" });

    const { title, excerpt, content, category, status } = req.body;
    const coverImage = req.file?.cloudinary?.secure_url || req.body.coverImage;

    const safeContent = content !== undefined ? sanitizeBlogHtml(content) : undefined;
    const nextStatus = status ?? existing.status;

    const post = await prisma.blogPost.update({
      where: { id },
      data: {
        // Re-slug only when the title actually changes, so existing links survive edits.
        ...(title && title !== existing.title
          ? { title, slug: await uniqueSlug(title, id) }
          : {}),
        ...(excerpt !== undefined ? { excerpt: excerpt || null } : {}),
        ...(safeContent !== undefined
          ? { content: safeContent, readTime: estimateReadTime(safeContent) }
          : {}),
        ...(coverImage !== undefined ? { coverImage: coverImage || null } : {}),
        ...(category !== undefined ? { category: category || "General" } : {}),
        ...(status !== undefined ? { status } : {}),
        // Stamp publishedAt the first time it goes live; keep the original date after.
        ...(nextStatus === "published" && !existing.publishedAt
          ? { publishedAt: new Date() }
          : {}),
        ...(nextStatus === "draft" ? { publishedAt: null } : {}),
      },
      include: { author: AUTHOR_SELECT },
    });

    res.json(post);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to update blog post" });
  }
};

export const deleteBlogPost = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.blogPost.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Post not found" });

    await prisma.blogPost.delete({ where: { id } });
    res.json({ message: "Post deleted" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to delete blog post" });
  }
};
