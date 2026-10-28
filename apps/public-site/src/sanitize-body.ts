import { isSafeUrl } from "@gcpe/http-kit";
import sanitizeHtml from "sanitize-html";
import { demoteHeadings } from "./pages/format";

/**
 * The release body (`detailsHtml`) and the minister's `details` are staff-authored HTML from
 * NRMS, trusted and rendered raw everywhere else in this codebase (spec §6.3's one named
 * exception). NRMS's editor being staff-only is an organisational control, not a technical one —
 * a public government site shouldn't rest its XSS safety on a single staff account never being
 * compromised and never pasting raw HTML. This is the public site's own, independent allowlist
 * sanitiser, defence in depth on top of (not instead of) NRMS's own write-time cleaning. It
 * never touches the News API: v1 responses are untouched, byte-identical.
 *
 * `h1` is allowed through sanitising only so `demoteHeadings` (below) has something to demote —
 * every `h1` that survives sanitising is converted to `h2` before this function returns, so no
 * caller of `sanitizeBodyHtml` ever sees one: the page's own `<h1>` stays unique (C209).
 */
const ALLOWED_TAGS = [
  "p", "br", "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "b", "em", "i", "u",
  "ul", "ol", "li",
  "blockquote",
  "a", "img",
  "table", "thead", "tbody", "tr", "th", "td", "caption",
  "figure", "figcaption",
  "hr", "span", "div", "sub", "sup",
]; // prettier-ignore

/** `a[href]` and `img[src]` are re-checked with `isSafeUrl` — the same helper the rest of the
 * public site uses — rather than trusting `sanitize-html`'s own scheme allowlist alone, so a
 * backslash-bypassed `/\host` (or anything else `isSafeUrl` refuses) is caught here too. */
function safeUrlAttribute(attributeName: "href" | "src", mailto: boolean) {
  return (tagName: string, attribs: Record<string, string>): sanitizeHtml.Tag => {
    const next = { ...attribs };
    const value = next[attributeName];
    if (value !== undefined && !isSafeUrl(value, { mailto })) delete next[attributeName];
    return { tagName, attribs: next };
  };
}

export function sanitizeBodyHtml(html: string): string {
  const cleaned = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ["href"],
      img: ["src", "alt", "width", "height", { name: "loading", multiple: false, values: ["lazy"] }],
      th: ["colspan", "rowspan"],
      td: ["colspan", "rowspan"],
    },
    // Only the classes renderBodyAssets (pages/media.ts) puts on its embeds; every other class goes.
    allowedClasses: {
      div: ["asset", "flickr", "youtube"],
      span: ["visually-hidden"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesAppliedToAttributes: ["href", "src"],
    allowProtocolRelative: false,
    transformTags: {
      a: safeUrlAttribute("href", true),
      img: safeUrlAttribute("src", false),
    },
    // An <a> with no href left (none given, or refused above) is unwrapped to its contents: no
    // hrefless <a> reaches a page (plan 2 P6). Core's sanitizeBioHtml does the same.
    exclusiveFilter: (frame) => (frame.tag === "a" && !frame.attribs.href ? "excludeTag" : false),
    // Removed entirely, content and all — never merely unwrapped to bare text.
    nonTextTags: ["script", "style", "textarea", "option", "noscript", "iframe", "object", "embed", "form"],
  });
  return demoteHeadings(cleaned);
}
