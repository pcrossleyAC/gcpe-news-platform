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

/** A fragment name a body may keep as an in-page link target: plain, short, nothing to escape. */
const FRAGMENT = /^[A-Za-z][\w.:-]{0,63}$/;

export interface BodyHtmlOptions {
  /**
   * The value of the `data-embed` attribute renderBodyAssets (pages/media.ts) puts on its own
   * embeds' classed elements. Only an element carrying it keeps its (allow-listed) classes, so
   * staff HTML can't borrow `span.visually-hidden` or `div.asset` to hide text from sighted
   * readers. A fresh random value per body: staff can't guess it. Absent: every class goes (bios).
   */
  embedMark?: string;
  /**
   * Keeps in-page `#name` links whose target (`id`, or a legacy `<a name>`) is in the same body,
   * as legacy did: both are rewritten to `#<prefix><name>`, so two bodies on one page (English and
   * French, backgrounders) and the page's own ids never collide. Absent: every `#…` link is
   * unwrapped to its text and every id dropped.
   */
  fragmentPrefix?: string;
}

/** The fragment names `html` both links to (`href="#x"`) and defines (`id="x"`, `<a name="x">`). */
function linkedFragments(html: string): Set<string> {
  const defined = new Set<string>();
  const linked = new Set<string>();
  // Output discarded: only the transform's view of every opening tag (it runs before the
  // allow-list check, so an empty list keeps nothing and warns about nothing).
  sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {},
    transformTags: {
      "*": (tagName, attribs) => {
        if (attribs.id) defined.add(attribs.id);
        if (tagName === "a" && attribs.name) defined.add(attribs.name);
        if (tagName === "a" && attribs.href?.startsWith("#")) linked.add(attribs.href.slice(1));
        return { tagName, attribs };
      },
    },
  });
  return new Set([...linked].filter((f) => defined.has(f) && FRAGMENT.test(f)));
}

export function sanitizeBodyHtml(html: string, opts: BodyHtmlOptions = {}): string {
  const prefix = opts.fragmentPrefix;
  const kept = prefix === undefined ? new Set<string>() : linkedFragments(html);
  const cleaned = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      "*": ["id"],
      a: ["href"],
      img: ["src", "alt", "width", "height", { name: "loading", multiple: false, values: ["lazy"] }],
      th: ["colspan", "rowspan"],
      td: ["colspan", "rowspan"],
    },
    // Only the classes renderBodyAssets puts on its embeds, and only on its own (embedMark).
    allowedClasses: {
      div: ["asset", "flickr", "youtube"],
      span: ["visually-hidden"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesAppliedToAttributes: ["href", "src"],
    allowProtocolRelative: false,
    transformTags: {
      "*": (tagName, attribs) => {
        const next = { ...attribs };
        const mark = next["data-embed"];
        delete next["data-embed"];
        if (opts.embedMark === undefined || mark !== opts.embedMark) delete next.class;
        // An id survives only as a kept link's target; a legacy <a name> target becomes a span.
        const target = next.id ?? (tagName === "a" && next.href === undefined ? next.name : undefined);
        delete next.id;
        delete next.name;
        if (target !== undefined && kept.has(target)) next.id = `${prefix}${target}`;
        if (tagName === "a" && next.href === undefined && next.id) return { tagName: "span", attribs: next };
        if (tagName === "a" && next.href !== undefined) {
          const frag = next.href.startsWith("#") ? next.href.slice(1) : null;
          // `a[href]` and `img[src]` are re-checked with `isSafeUrl` — the same helper the rest of
          // the public site uses — rather than trusting sanitize-html's own scheme allowlist
          // alone, so a backslash-bypassed `/\host` (or anything else isSafeUrl refuses) is caught.
          if (frag !== null) {
            if (kept.has(frag)) next.href = `#${prefix}${frag}`;
            else delete next.href;
          } else if (!isSafeUrl(next.href, { mailto: true })) delete next.href;
        }
        if (tagName === "img" && next.src !== undefined && !isSafeUrl(next.src, { mailto: false })) delete next.src;
        return { tagName, attribs: next };
      },
    },
    // An <a> with no href left (none given, or refused above) is unwrapped to its contents: no
    // hrefless <a> reaches a page (plan 2 P6). Core's sanitizeBioHtml does the same. (A kept
    // `<a name>` target was renamed to a span above; `frame.tag` is still the source tag.)
    exclusiveFilter: (frame) => (frame.tag === "a" && !frame.attribs.href && !frame.attribs.id ? "excludeTag" : false),
    // Removed entirely, content and all — never merely unwrapped to bare text.
    nonTextTags: ["script", "style", "textarea", "option", "noscript", "iframe", "object", "embed", "form"],
  });
  return demoteHeadings(cleaned);
}
