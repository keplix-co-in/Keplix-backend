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

const posts = [
  {
    title: "When Should You Change Your Engine Oil?",
    category: "Maintenance",
    excerpt:
      "Engine oil intervals are more nuanced than the sticker on your windscreen. Here's how to judge it properly.",
    content: `
      <p>Oil is the single cheapest thing standing between your engine and a repair bill in the lakhs. Yet most owners either change it far too often, or forget about it entirely until something rattles.</p>
      <h2>The short answer</h2>
      <p>For most petrol cars in India, <strong>every 10,000 km or 12 months</strong>, whichever comes first. Diesel engines work harder and run dirtier, so aim closer to <strong>7,000-8,000 km</strong>.</p>
      <h2>When to shorten that interval</h2>
      <p>Your driving conditions matter more than the odometer. Change it sooner if most of your driving looks like this:</p>
      <ul>
        <li>Stop-start city traffic, where the engine idles hot for long stretches</li>
        <li>Very short trips where the engine never fully warms up</li>
        <li>Dusty or unsealed roads</li>
        <li>Regular heavy loads, or towing</li>
      </ul>
      <h2>How to check it yourself</h2>
      <p>Park level, wait for the engine to cool, then pull the dipstick, wipe it, reinsert fully and pull again. You're looking at two things — the level should sit between the two marks, and the oil should be translucent amber. Gritty, or black like coffee? It's overdue.</p>
      <blockquote>If the oil is milky or foamy, stop and get it looked at. That usually means coolant is getting in, which is a much bigger problem than a service.</blockquote>
      <h2>Don't skip the filter</h2>
      <p>Changing oil while keeping the old filter is a false economy — the filter holds a fair amount of dirty oil that immediately contaminates the new. Any competent workshop replaces both as a matter of course.</p>
    `,
  },
  {
    title: "How to Choose a Garage You Can Actually Trust",
    category: "Guides",
    excerpt:
      "Six practical checks that separate a good workshop from an expensive lesson.",
    content: `
      <p>Most people pick a garage based on whichever is closest. That works right up until it doesn't. A few minutes of checking upfront saves a lot of money and argument later.</p>
      <h2>1. Ask for the estimate in writing</h2>
      <p>A trustworthy workshop will happily itemise parts and labour before touching anything. Vague verbal quotes are where bills quietly grow.</p>
      <h2>2. Ask what happens to the old parts</h2>
      <p>Good garages will show you what they replaced without being asked twice. It's one of the quickest honesty checks there is.</p>
      <h2>3. Check the warranty on the work</h2>
      <p>Serious workshops stand behind their labour, typically for <strong>1,000 km or one month</strong> at minimum. No warranty at all is a meaningful signal.</p>
      <h2>4. Look at reviews with a skeptical eye</h2>
      <p>Ignore the star rating and read the three-star reviews — they're usually the honest ones. Look for patterns rather than individual complaints, and note how the workshop responds to criticism.</p>
      <h2>5. Match the garage to the job</h2>
      <ul>
        <li><strong>Authorised service centre</strong> — warranty work and complex electronics</li>
        <li><strong>Multi-brand workshop</strong> — routine servicing at better prices</li>
        <li><strong>Specialist</strong> — tyres, AC, denting and painting done properly</li>
      </ul>
      <h2>6. Start small</h2>
      <p>Give a new garage something low-risk first, like an oil change or wheel alignment. See how they communicate and whether the bill matches the quote before trusting them with a clutch job.</p>
    `,
  },
  {
    title: "Monsoon Car Care: What Actually Matters",
    category: "Seasonal",
    excerpt:
      "Wipers, tyres, brakes and the drainage holes nobody thinks about until the carpet is soaked.",
    content: `
      <p>The monsoon punishes cars in ways summer doesn't — standing water, permanent damp and dramatically less grip. A short checklist before the rains beats an expensive repair during them.</p>
      <h2>Tyres come first</h2>
      <p>Tread depth is what clears water out from under the tyre. Below <strong>3 mm</strong> your stopping distance in the wet increases sharply, and aquaplaning becomes a genuine risk. Check with a coin if you don't have a gauge.</p>
      <h2>Wipers and visibility</h2>
      <p>Wiper blades harden and split in the summer heat, so replace them <em>before</em> the first heavy shower, not after. Top up the washer reservoir and check that both jets aim properly.</p>
      <h2>Brakes take longer to bite</h2>
      <p>Wet discs need a moment to clear. Leave significantly more following distance, and after driving through deep water, dab the brakes gently a few times to dry them off.</p>
      <h2>The drainage holes nobody checks</h2>
      <p>Sunroofs, door bottoms and the scuttle below the windscreen all have drain holes that clog with leaves and grit. Blocked drains are the usual reason a footwell mysteriously floods.</p>
      <h2>If you must drive through water</h2>
      <ul>
        <li>Don't attempt anything above the bottom of the door</li>
        <li>Go slow and steady in first gear, keeping the revs up</li>
        <li>Never restart an engine that stalled in water — that's how you turn a tow into an engine rebuild</li>
      </ul>
    `,
  },
  {
    title: "EV Maintenance: What Changes and What Doesn't",
    category: "EV",
    excerpt:
      "No oil changes, but battery habits and brake care still need attention.",
    content: `
      <p>Electric cars remove a lot of routine maintenance — no oil, no spark plugs, no exhaust, no clutch. But "less maintenance" isn't "none", and a couple of things need <em>more</em> attention than in a petrol car.</p>
      <h2>Battery habits matter most</h2>
      <p>The battery is by far the most expensive component, and how you charge it affects how long it lasts:</p>
      <ul>
        <li>For daily use, keep the charge roughly between <strong>20% and 80%</strong></li>
        <li>Only charge to 100% when you actually need the full range</li>
        <li>Use DC fast charging when travelling, not as your everyday habit — heat is what ages cells</li>
        <li>Avoid leaving the car at very low charge for weeks</li>
      </ul>
      <h2>Brakes wear less, but rust more</h2>
      <p>Regenerative braking means the friction brakes do far less work, so pads can last years. The catch is that lightly-used discs corrode. Occasional firmer braking helps clean them, and the calipers still need periodic servicing.</p>
      <h2>Tyres wear faster</h2>
      <p>EVs are heavy and deliver torque instantly, which is hard on tyres. Rotate them more often than you would on a petrol car and keep pressures exactly to spec — under-inflation costs you noticeable range.</p>
      <h2>Still on the list</h2>
      <p>Cabin air filter, brake fluid, coolant for the battery thermal system, suspension and wipers all remain ordinary service items. And software updates increasingly count as maintenance too.</p>
    `,
  },
  {
    title: "Tyre Care 101: Pressure, Tread and Rotation",
    category: "Maintenance",
    excerpt:
      "Your tyres are the only part of the car touching the road. Four small habits make them last far longer.",
    content: `
      <p>Four contact patches, each roughly the size of your palm, carry everything the car does — accelerating, braking, cornering. Tyres are the highest-leverage maintenance item on any vehicle, and the most neglected.</p>
      <h2>Check pressure monthly, when cold</h2>
      <p>Tyres lose roughly <strong>1 PSI a month</strong> naturally, and more in cold weather. Always measure before driving, since even a few kilometres warms the air and inflates the reading. The correct figure is on the driver's door jamb — not on the tyre sidewall, which is the maximum, not the recommendation.</p>
      <h2>Read the tread</h2>
      <p>Every tyre has wear indicators moulded into the grooves. When the tread is flush with those bars, the tyre is legally and practically finished. Uneven wear tells you something else is wrong:</p>
      <ul>
        <li><strong>Both edges worn</strong> — chronic under-inflation</li>
        <li><strong>Centre worn</strong> — over-inflation</li>
        <li><strong>One edge only</strong> — alignment needs attention</li>
        <li><strong>Patchy or scalloped</strong> — worn suspension or unbalanced wheels</li>
      </ul>
      <h2>Rotate every 8,000-10,000 km</h2>
      <p>Front tyres wear faster on most cars — they steer and, on front-wheel drive, put the power down too. Rotating evens that out and meaningfully extends the life of the full set.</p>
      <h2>Age matters, not just tread</h2>
      <p>Rubber hardens over time regardless of use. Check the four-digit DOT code on the sidewall — "2224" means the 22nd week of 2024. Anything past five or six years is worth inspecting closely, even if the tread looks healthy.</p>
    `,
  },
  {
    title: "Summer Car Care Checklist",
    category: "Seasonal",
    excerpt:
      "Heat is hard on batteries, coolant and AC. A short pre-summer check avoids a roadside breakdown.",
    content: `
      <p>Indian summers are brutal on cars. Heat kills batteries faster than cold does, thins your oil, stresses the cooling system and exposes every weakness in the AC.</p>
      <h2>Cooling system first</h2>
      <p>Overheating is the most common summer breakdown and the most preventable. Check the coolant level when the engine is <strong>completely cold</strong> — never open a hot radiator cap. Look for crusty white residue around hoses and joints, which points to a slow leak.</p>
      <h2>Battery</h2>
      <p>Heat accelerates the chemical wear inside a battery, and most failures happen in summer even though they surface on a cold morning. If yours is over three years old, get it load-tested rather than waiting for it to strand you.</p>
      <h2>Air conditioning</h2>
      <p>If the AC blows cool rather than cold, it's usually low refrigerant or a clogged cabin filter. The filter is cheap and often something you can change yourself in ten minutes — start there before paying for a regas.</p>
      <h2>Tyres, again</h2>
      <p>Hot roads plus under-inflation is the classic recipe for a blowout. Air expands as it heats, so measure pressures in the morning and never bleed air out of a hot tyre to "correct" a high reading.</p>
      <h2>Protect the interior</h2>
      <ul>
        <li>Use a windscreen shade — it slows dashboard cracking and fading</li>
        <li>Park in shade where you can, even if it means a longer walk</li>
        <li>Crack the windows a few millimetres if it's safe to do so</li>
      </ul>
    `,
  },
];

const run = async () => {
  const author = await prisma.admin.findFirst({ select: { id: true } });
  if (!author) console.warn("No Admin row found — seeding posts without an author.");

  // Stagger publish dates a week apart so the listing has a natural order.
  const now = Date.now();
  const WEEK = 7 * 24 * 60 * 60 * 1000;

  for (const [i, post] of posts.entries()) {
    const content = sanitizeBlogHtml(post.content.trim());
    const existing = await prisma.blogPost.findFirst({
      where: { title: post.title },
      select: { id: true },
    });

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
        data: { ...data, slug: await uniqueSlug(post.title) },
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
