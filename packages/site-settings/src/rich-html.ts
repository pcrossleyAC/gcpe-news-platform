import { isSafeUrl } from "@gcpe/http-kit/url";
import sanitizeHtml from "sanitize-html";
import type { StoredSiteSettings } from "./model";

/**
 * Node-only (sanitize-html), so it is a subpath export (`@gcpe/site-settings/rich-html`), not
 * part of the browser-safe main entry.
 *
 * The one allow-list for staff-authored rich HTML that reaches the public site: the public site's
 * render-time sanitiser (apps/public-site/src/sanitize-body.ts, which adds heading demotion on
 * top) and NRMS's save-time cleaning of rich site-settings fields both call `cleanRichHtml`, so
 * the two cannot drift (plan 4 ruling P4-R4). Core's bio sanitiser (apps/core bio-html.ts) is
 * separate and stays a subset of this list.
 *
 * `h1` is allowed here; the public site's sanitizeBodyHtml demotes every heading one level so the
 * page's own `<h1>` stays unique (C209).
 */
export const RICH_HTML_TAGS = [
  "p", "br", "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "b", "em", "i", "u",
  "ul", "ol", "li",
  "blockquote",
  "a", "img",
  "table", "thead", "tbody", "tr", "th", "td", "caption",
  "figure", "figcaption",
  "hr", "span", "div", "sub", "sup",
] as const; // prettier-ignore

/** A fragment name a body may keep as an in-page link target: plain, short, nothing to escape. */
const FRAGMENT = /^[A-Za-z][\w.:-]{0,63}$/;

/** Removed entirely, content and all — never merely unwrapped to bare text. */
const NON_TEXT_TAGS = ["script", "style", "textarea", "option", "noscript", "iframe", "object", "embed", "form"];

export interface RichHtmlOptions {
  /**
   * The value of the `data-embed` attribute renderBodyAssets (public-site pages/media.ts) puts on
   * its own embeds' classed elements. Only an element carrying it keeps its (allow-listed)
   * classes, so staff HTML can't borrow `span.visually-hidden` or `div.asset` to hide text from
   * sighted readers. A fresh random value per body: staff can't guess it. Absent: every class goes.
   */
  embedMark?: string;
  /**
   * Keeps in-page `#name` links whose target (`id`, or a legacy `<a name>`) is in the same body,
   * as legacy did: both are rewritten to `#<prefix><name>`, so two bodies on one page (English and
   * French, backgrounders) and the page's own ids never collide. Absent: every `#…` link is
   * unwrapped to its text and every id dropped.
   */
  fragmentPrefix?: string;
  /**
   * false: every `<img>` is dropped. Settings rich text (the Media contacts intro, the page text
   * bodies) is edited with assets off, so an image there was pasted in; it never reaches the page
   * (plan 4 Review Focus 2). Absent or true: images are kept (release bodies, bios).
   */
  images?: boolean;
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

/** Allow-list cleaning of staff rich HTML (no heading demotion — see the module comment). */
export function cleanRichHtml(html: string, opts: RichHtmlOptions = {}): string {
  const prefix = opts.fragmentPrefix;
  const kept = prefix === undefined ? new Set<string>() : linkedFragments(html);
  return sanitizeHtml(html, {
    allowedTags: opts.images === false ? RICH_HTML_TAGS.filter((t) => t !== "img") : [...RICH_HTML_TAGS],
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
    nonTextTags: NON_TEXT_TAGS,
  });
}

/**
 * `html` parsed and written back by the same parser and serialiser as `cleanRichHtml`, keeping
 * every tag and attribute: what cleaning would output if the allow-list removed nothing.
 */
function reserialised(html: string): string {
  return sanitizeHtml(html, { allowedTags: false, allowedAttributes: false, allowVulnerableTags: true, nonTextTags: [] });
}

/**
 * Save-time cleaning of one rich settings field (images off, like every settings editor). When
 * the allow-list would remove nothing, the stored text comes back byte-identical (entities such
 * as `&rsquo;`, `<br />` spelling and newlines kept), so re-saving an already clean document
 * changes nothing; otherwise the cleaned HTML replaces it.
 */
export function cleanSettingsHtml(html: string): string {
  if (html === "") return html;
  const cleaned = cleanRichHtml(html, { images: false });
  // Raw text is kept only when it holds no markup declaration (comment, CDATA, doctype, processing
  // instruction): htmlparser2 and browsers disagree on those, so "nothing removed" by our parser
  // would not mean "nothing live" in a browser (<![CDATA[><img onerror>]]> is a live img there).
  return !/<[!?]/.test(html) && cleaned === reserialised(html) ? html : cleaned;
}

/**
 * `doc` with every rich HTML field cleaned by `cleanSettingsHtml` (the fields the Hub edits with
 * the rich-text editor: validate.ts checks them with `plain: false`). A section the stored
 * document lacks stays absent. Returns the same object when nothing changed.
 */
export function cleanSettingsRichHtml<T extends StoredSiteSettings>(doc: T): T {
  let out = doc;
  const cp = doc.contactsPage;
  if (cp) {
    const introHtml = cleanSettingsHtml(cp.introHtml);
    if (introHtml !== cp.introHtml) out = { ...out, contactsPage: { ...cp, introHtml } };
  }
  const t = doc.pageText;
  if (t) {
    const next = {
      ...t,
      privacy: { ...t.privacy, bodyHtml: cleanSettingsHtml(t.privacy.bodyHtml) },
      live: { ...t.live, consentHtml: cleanSettingsHtml(t.live.consentHtml), offAirHtml: cleanSettingsHtml(t.live.offAirHtml) },
      collectionNotice: { ...t.collectionNotice, bodyHtml: cleanSettingsHtml(t.collectionNotice.bodyHtml) },
      subscribeHelpHtml: cleanSettingsHtml(t.subscribeHelpHtml),
    };
    const changed =
      next.privacy.bodyHtml !== t.privacy.bodyHtml ||
      next.live.consentHtml !== t.live.consentHtml ||
      next.live.offAirHtml !== t.live.offAirHtml ||
      next.collectionNotice.bodyHtml !== t.collectionNotice.bodyHtml ||
      next.subscribeHelpHtml !== t.subscribeHelpHtml;
    if (changed) out = { ...out, pageText: next };
  }
  return out;
}

/** The rich HTML fields `cleanSettingsRichHtml` cleans, by validation path (kept in step by a test). */
export const SETTINGS_RICH_HTML_FIELDS = [
  "contactsPage.introHtml",
  "pageText.privacy.bodyHtml",
  "pageText.live.consentHtml",
  "pageText.live.offAirHtml",
  "pageText.collectionNotice.bodyHtml",
  "pageText.subscribeHelpHtml",
] as const;
