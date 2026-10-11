import { DomUtils, parseDocument } from "htmlparser2";
import type { ChildNode } from "domhandler";

const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "figcaption", "figure", "footer",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "ol", "p", "pre", "section", "table", "td", "th", "tr", "ul",
]);
const SKIP = new Set(["script", "style", "noscript", "template", "head"]);

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Release HTML to one line of plain text: entities decoded, blocks separated by a space. */
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return "";
  const out: string[] = [];
  const walk = (nodes: ChildNode[]): void => {
    for (const n of nodes) {
      if (DomUtils.isText(n)) {
        out.push(n.data);
      } else if (DomUtils.isTag(n) && !SKIP.has(n.name.toLowerCase())) {
        const block = BLOCK.has(n.name.toLowerCase());
        if (block) out.push(" ");
        walk(n.children);
        if (block) out.push(" ");
      }
    }
  };
  walk(parseDocument(html).children);
  return collapseWhitespace(out.join(""));
}

/** Lower case, NFKC, letters and digits only, single spaces. Used for hashing and cache keys. */
export function normaliseForEmbedding(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
