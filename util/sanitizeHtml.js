import { FilterXSS } from "xss";

/**
 * Blog bodies are author-written HTML from the admin's rich-text editor, so we
 * can't run them through the blanket `sanitizeInput` middleware — it would strip
 * the formatting. Instead allow exactly the tags the editor can produce and drop
 * everything else (scripts, iframes, on* handlers, javascript: URLs).
 */
const filter = new FilterXSS({
  whiteList: {
    p: [],
    br: [],
    strong: [],
    b: [],
    em: [],
    i: [],
    u: [],
    s: [],
    h1: [],
    h2: [],
    h3: [],
    h4: [],
    ul: [],
    ol: [],
    li: [],
    blockquote: [],
    code: [],
    pre: [],
    hr: [],
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title", "width", "height"],
  },
  // Drop the contents of disallowed tags too, so <script>alert(1)</script>
  // doesn't leave "alert(1)" behind as visible text.
  stripIgnoreTagBody: ["script", "style", "iframe", "object", "embed"],
  onTagAttr: (tag, name, value) => {
    // Block javascript:/data: URLs that survive attribute-level filtering.
    if ((tag === "a" && name === "href") || (tag === "img" && name === "src")) {
      const safe = /^(https?:|mailto:|\/|#)/i.test(value.trim());
      if (!safe) return "";
    }
    return undefined; // fall through to default handling
  },
});

export const sanitizeBlogHtml = (html) =>
  typeof html === "string" ? filter.process(html) : "";

/** Rough reading time in minutes from the HTML body. */
export const estimateReadTime = (html) => {
  const words = String(html)
    .replace(/<[^>]*>/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
};
