/**
 * Seeds starter blog posts so the marketing site's /blog page isn't empty.
 *
 * Idempotent: matches on slug, so re-running updates rather than duplicating.
 * Content goes through the same sanitize/slug/read-time helpers the admin API
 * uses, so these are indistinguishable from posts written in the panel — and
 * can be edited or deleted there like any other.
 *
 *   node prisma/seedBlogs.js
 */
import "dotenv/config";
import prisma from "../util/prisma.js";
import { uniqueSlug } from "../util/slugify.js";
import { sanitizeBlogHtml, estimateReadTime } from "../util/sanitizeHtml.js";
// Post bodies live in prisma/blog/, split across four files so each stays
// reviewable. index.js concatenates them and validates for duplicate titles.
import posts from "./blog/index.js";

const run = async () => {
  const author = await prisma.admin.findFirst({ select: { id: true } });
  if (!author) console.warn("No Admin row found — seeding posts without an author.");

  // Stagger publish dates a week apart so the listing has a natural order.
  const now = Date.now();
  const WEEK = 7 * 24 * 60 * 60 * 1000;

  for (const [i, post] of posts.entries()) {
    const content = sanitizeBlogHtml(post.content.trim());

    // Match on SLUG, not title.
    //
    // Matching on title looks equivalent and is not: the slug is the stable
    // identity (it is what is indexed and linked), while the title is editable
    // prose. Edit a title here by even one word and a title match finds nothing,
    // so the seed CREATES a second row instead of updating the first.
    //
    // That is not hypothetical -- it already happened. A live post titled
    // "Summer Car Care Check" did not match this file's "Summer Car Care
    // Checklist", so a reseed left both: the new 1,000-word version alongside the
    // old 232-word one, competing for the same query. Slug matching makes the
    // seed genuinely idempotent no matter how the title is edited.
    //
    // Falls back to title for any row predating explicit slugs.
    const existing =
      (post.slug
        ? await prisma.blogPost.findUnique({
            where: { slug: post.slug },
            select: { id: true },
          })
        : null) ??
      (await prisma.blogPost.findFirst({
        where: { title: post.title },
        select: { id: true },
      }));

    const data = {
      title: post.title,
      excerpt: post.excerpt,
      content,
      category: post.category,
      readTime: estimateReadTime(content),
      status: "published",
      publishedAt: new Date(now - i * WEEK),
      authorId: author?.id ?? null,
    };

    if (existing) {
      await prisma.blogPost.update({ where: { id: existing.id }, data });
      console.log(`updated  ${post.title}`);
    } else {
      const created = await prisma.blogPost.create({
        // Declared slug wins; uniqueSlug() only for posts that omit one.
        data: { ...data, slug: post.slug ?? (await uniqueSlug(post.title)) },
      });
      console.log(`created  ${created.slug}  (${created.readTime} min read)`);
    }
  }

  const total = await prisma.blogPost.count({ where: { status: "published" } });
  console.log(`\nPublished posts now live: ${total}`);
  await prisma.$disconnect();
};

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
