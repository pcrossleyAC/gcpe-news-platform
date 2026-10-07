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
function parseDate(raw: string): Date | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t);
}

function toAlert(r: { identity: string; link: string; title: string; html: string; published: string }): FeedAlert | null {
  const title = squash(r.title).slice(0, MAX_TITLE_LENGTH);
  if (!isHttpUrl(r.link) || !title) return null;
  return {
    identity: r.identity || r.link,
    link: r.link,
    title,
    text: htmlToText(r.html).slice(0, MAX_ALERT_TEXT),
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

/**
 * RSS 2.0 or Atom → alerts. Parsed in XML mode, which resolves no DTD or external entity. A
 * body that doesn't end with its root's closing tag is rejected whole: a feed cut off mid-download
 * would otherwise yield its last alert with half its text, and that alert would be emailed.
 */
export function parseEmergencyFeed(xml: string): ParsedFeed {
  if (!/<\/(rss|feed)>\s*$/.test(xml)) throw new FeedFormatError();
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
    const alert = root.name === "rss" ? fromRssItem(e) : fromAtomEntry(e);
    if (alert) alerts.push(alert);
    else skipped += 1;
  }
  return { alerts, skipped };
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
