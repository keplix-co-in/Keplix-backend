import prisma from "./prisma.js";

/** "Why Your Car Needs a Service!" -> "why-your-car-needs-a-service" */
export const slugify = (text) =>
  String(text)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "post";

/**
 * Slug that's unique across BlogPost. Appends -2, -3, ... on collision.
 * `ignoreId` lets an existing post keep its own slug while editing.
 */
export const uniqueSlug = async (title, ignoreId = null) => {
  const base = slugify(title);
  let candidate = base;

  for (let n = 2; ; n += 1) {
    const clash = await prisma.blogPost.findFirst({
      where: {
        slug: candidate,
        ...(ignoreId ? { NOT: { id: ignoreId } } : {}),
      },
      select: { id: true },
    });

    if (!clash) return candidate;
    candidate = `${base}-${n}`;
  }
};
