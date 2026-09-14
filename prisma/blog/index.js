/**
 * All blog posts, in publication order.
 *
 * Split across four files purely so each is reviewable; a single array of this
 * length produces diffs nobody can read. Order here is the order they are
 * published in, and prisma/seedBlogs.js staggers publishedAt a week apart down
 * the list, so the first entry is the newest on the site.
 */
import part1 from "./posts-part1.js";
import part2 from "./posts-part2.js";
import part3 from "./posts-part3.js";
import part4 from "./posts-part4.js";

const posts = [...part1, ...part2, ...part3, ...part4];

// A duplicate title would silently update the wrong row on reseed, because the
// seed matches on title. Cheaper to catch it here than to debug it later.
const titles = posts.map((p) => p.title);
const duplicates = titles.filter((t, i) => titles.indexOf(t) !== i);
if (duplicates.length) {
  throw new Error(`Duplicate blog post titles: ${duplicates.join(", ")}`);
}

// The slug is the stable identity the seed matches on, so a missing or duplicated
// one is what creates orphan posts. Fail here rather than discover it in
// production as two near-identical articles competing for the same query.
const slugs = posts.map((p) => p.slug);
const duplicateSlugs = slugs.filter((s, i) => slugs.indexOf(s) !== i);
if (duplicateSlugs.length) {
  throw new Error(`Duplicate blog post slugs: ${duplicateSlugs.join(", ")}`);
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

for (const post of posts) {
  for (const field of ["title", "slug", "category", "excerpt", "content"]) {
    if (!post[field] || typeof post[field] !== "string") {
      throw new Error(`Blog post "${post.title ?? "(untitled)"}" is missing ${field}`);
    }
  }
  if (!SLUG_PATTERN.test(post.slug)) {
    throw new Error(
      `Blog post "${post.title}" has an invalid slug "${post.slug}" -- ` +
        `lowercase letters, digits and single hyphens only.`,
    );
  }
}

export default posts;
