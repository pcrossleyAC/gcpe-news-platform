import { DomUtils, parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";

/** One alert, normalised for an `items` row. */
export interface FeedAlert {
  /** The feed's own id for the alert (RSS guid, Atom id), else its link. */
  identity: string;
  link: string;
  title: string;
  /** The alert's full content as plain text; paragraphs are separated by a blank line. */
  text: string;
  publishedAt: Date | null;
}

export interface ParsedFeed {
  alerts: FeedAlert[];
  /** Entries without a title or an http(s) link. */
  skipped: number;
}

/** Not RSS 2.0 or Atom, or cut off before its closing tag. */
export class FeedFormatError extends Error {
  constructor() {
    super("not a complete RSS or Atom feed");
    this.name = "FeedFormatError";
  }
}

export const MAX_TITLE_LENGTH = 500;
export const MAX_ALERT_TEXT = 20_000;

const isHttpUrl = (s: string): boolean => /^https?:\/\/\S+$/i.test(s);
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Every C0 control character except tab/LF/CR, plus DEL -- a raw one of these (most often a
 * NUL from a legacy export) makes Postgres reject the whole insert (22021), which otherwise
 * stops the ingester partway through a feed, every 5 minutes, until the feed changes again. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
export const stripControl = (s: string): string => s.replace(CONTROL_CHARS, "");

/** Unicode bidi override codepoints (LRE/RLE/PDF/LRO/RLO, 0x202A-0x202E) and isolate codepoints
 * (LRI/RLI/FSI/PDI, 0x2066-0x2069) -- named by codepoint, not written as literal characters,
 * so the characters this guards against never themselves sit in this source file. Removing
 * them keeps an alert's title reading the same order it's actually made of, rather than
 * whatever order these could otherwise force an email subject line to display it in. */
function isBidiOverrideCodePoint(code: number): boolean {
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}
const stripBidiOverrides = (s: string): string => Array.from(s, (ch) => (isBidiOverrideCodePoint(ch.codePointAt(0)!) ? "" : ch)).join("");

/**
 * A comparison key for "is this the same alert link" -- lower-cases the host, treats `http`
 * and `https` as the same scheme, and trims one trailing slash from the path. Never stored
 * itself (the real link, `toAlert`'s own `link`, keeps its actual scheme/case/slash); used only
 * for the no-guid identity fallback below and, identically, by the ingester's own known-alert
 * match (emergency/ingest.ts), so a link that merely changed case or scheme is still the same
 * alert on both sides. Falls back to the raw string when it isn't a parseable URL at all, so an
 * already-stored, pre-this-fix value still compares as itself rather than throwing.
 */
export function normalizeLinkIdentity(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const scheme = url.protocol === "http:" ? "https:" : url.protocol;
  const path = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  return `${scheme}//${url.host.toLowerCase()}${path}${url.search}`;
}

/** A clean, absolute http(s) URL for `raw` -- percent-encoded via `URL#href` so an odd
 * character (accented, embedded unicode) can never make the stored url fail the item API's
 * `z.string().url()` -- or null when `raw` isn't an http(s) URL at all. */
function canonicalLink(raw: string): string | null {
  const cleaned = stripControl(raw).trim();
  if (!isHttpUrl(cleaned)) return null;
  try {
    return new URL(cleaned).href;
  } catch {
    return null;
  }
}

function elementsOf(nodes: ChildNode[]): Element[] {
  return nodes.filter((c): c is Element => DomUtils.isTag(c));
}
function child(el: Element, name: string): Element | undefined {
  return elementsOf(el.children).find((c) => c.name === name);
}
function childText(el: Element, name: string): string {
  const c = child(el, name);
  return c ? DomUtils.textContent(c).trim() : "";
}
/** Null for anything outside Postgres's practical `timestamptz` range -- years 1-9999 is
 * enough; a feed date `Date.parse` happily accepts outside that (a garbled "99999", or an
 * all-zero "0000-01-01") would otherwise reach the database and fail the whole insert. */
function parseDate(raw: string): Date | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const year = d.getUTCFullYear();
  return year >= 1 && year <= 9999 ? d : null;
}

function toAlert(r: { identity: string; link: string; title: string; html: string; published: string }): FeedAlert | null {
  const link = canonicalLink(r.link);
  if (!link) return null;
  const title = stripControl(stripBidiOverrides(squash(r.title))).slice(0, MAX_TITLE_LENGTH);
  if (!title) return null;
  const identity = stripControl(r.identity).trim() || normalizeLinkIdentity(link);
  return {
    identity,
    link,
    title,
    text: stripControl(htmlToText(r.html)).slice(0, MAX_ALERT_TEXT),
    publishedAt: parseDate(r.published),
  };
}

function fromRssItem(item: Element): FeedAlert | null {
  return toAlert({
    identity: childText(item, "guid"),
    link: childText(item, "link"),
    title: childText(item, "title"),
    html: childText(item, "content:encoded") || childText(item, "description"),
    published: childText(item, "pubDate"),
  });
}

function fromAtomEntry(entry: Element): FeedAlert | null {
  const links = elementsOf(entry.children).filter((c) => c.name === "link");
  const alternate = links.find((l) => (l.attribs.rel ?? "alternate") === "alternate");
  return toAlert({
    identity: childText(entry, "id"),
    link: (alternate?.attribs.href ?? "").trim(),
    title: childText(entry, "title"),
    html: childText(entry, "content") || childText(entry, "summary"),
    published: childText(entry, "published") || childText(entry, "updated"),
  });
}

/** One entry as an alert, or null to skip it: no title or http(s) link, or markup nested deeply
 * enough to overflow the stack in a recursive walk (htmlToText, or reading its text), which
 * nothing bounded by MAX_FEED_BYTES prevents. One such alert never costs the rest of the feed. */
function entryToAlert(e: Element, rss: boolean): FeedAlert | null {
  try {
    return rss ? fromRssItem(e) : fromAtomEntry(e);
  } catch (err) {
    if (err instanceof RangeError) return null;
    throw err;
  }
}

/**
 * RSS 2.0 or Atom → alerts. Parsed in XML mode, which resolves no DTD or external entity. A
 * body that doesn't end with its root's closing tag is rejected whole: a feed cut off mid-download
 * would otherwise yield its last alert with half its text, and that alert would be emailed.
 */
export function parseEmergencyFeed(xml: string): ParsedFeed {
  // Trailing whitespace or a comment (e.g. a caching proxy's own `<!-- cached -->`) after the
  // real close is fine; anything else there means the body was cut off before its end.
  if (!/<\/(rss|feed)>(?:\s|<!--[\s\S]*?-->)*$/.test(xml)) throw new FeedFormatError();
  try {
    const doc = parseDocument(xml, { xmlMode: true });
    const root = elementsOf(doc.children).find((c) => c.name === "rss" || c.name === "feed");
    if (!root) throw new FeedFormatError();
    const entries =
      root.name === "rss"
        ? elementsOf((child(root, "channel") ?? root).children).filter((c) => c.name === "item")
        : elementsOf(root.children).filter((c) => c.name === "entry");
    const alerts: FeedAlert[] = [];
    let skipped = 0;
    for (const e of entries) {
      const alert = entryToAlert(e, root.name === "rss");
      if (alert) alerts.push(alert);
      else skipped += 1;
    }
    return { alerts, skipped };
  } catch (e) {
    // Markup nested deeply enough to overflow the stack outside any one entry is treated the
    // same as any other unparseable body, not as a crash.
    if (e instanceof FeedFormatError) throw e;
    if (e instanceof RangeError) throw new FeedFormatError();
    throw e;
  }
}

const BLOCK = new Set(["p", "div", "section", "article", "header", "footer", "ul", "ol", "table", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "figure", "hr"]);
const SKIP = new Set(["script", "style", "head", "noscript", "template"]);

/** Alert HTML → plain text: blocks become paragraphs, list items "- " lines, links "text (url)". */
export function htmlToText(html: string): string {
  if (!html.trim()) return "";
  const out: string[] = [];
  const walk = (nodes: ChildNode[]): void => {
    for (const n of nodes) {
      if (DomUtils.isText(n)) {
        out.push(n.data.replace(/\s+/g, " "));
        continue;
      }
      if (!DomUtils.isTag(n) || SKIP.has(n.name)) continue;
      if (n.name === "br") {
        out.push("\n");
        continue;
      }
      const block = BLOCK.has(n.name);
      if (block) out.push("\n\n");
      if (n.name === "li") out.push("\n- ");
      walk(n.children);
      if (n.name === "a") {
        const href = (n.attribs.href ?? "").trim();
        if (isHttpUrl(href) && href !== squash(DomUtils.textContent(n))) out.push(` (${href})`);
      }
      if (block) out.push("\n\n");
    }
  };
  walk(parseDocument(html).children);
  return out
    .join("")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
