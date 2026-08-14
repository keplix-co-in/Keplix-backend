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
  author: { select: { name: true } },
};

export const listPublishedPosts = async (req, res) => {
  try {
    const { page = 1, limit = 24, category } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where = {
      status: "published",
      ...(category && category !== "All" ? { category } : {}),
    };

    const [posts, total] = await Promise.all([
      prisma.blogPost.findMany({
        where,
        orderBy: { publishedAt: "desc" },
        skip: Number(skip),
        take: Number(limit),
        select: PUBLIC_SELECT,
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
