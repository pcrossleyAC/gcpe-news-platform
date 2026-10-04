import { parseDocument } from "htmlparser2";
import { isTag, isText, type ChildNode } from "domhandler";

const NL = "\r\n";
const ASSET = /<asset>[^<]+<\/asset>/g;

/** Port of legacy Gcpe.News.ReleaseManagement.Templates/Convert.cs HtmlToText. */
export function htmlToText(html: string): string {
  if (html === "") return "";
  const cleaned = html.replace(ASSET, "").replaceAll("<p>&nbsp;</p>", "").replaceAll("<p></p>", "");
  return parseDocument(cleaned).children.map(node).join("");
}

function children(n: ChildNode): string {
  return isTag(n) ? n.children.map(node).join("") : "";
}

function node(n: ChildNode): string {
  if (isText(n)) return n.data.replace(/^[\r\n]+|[\r\n]+$/g, "");
  if (!isTag(n)) return "";
  switch (n.name.toLowerCase()) {
    case "a": {
      const raw = n.attribs.href;
      const href = raw && !raw.startsWith("#") ? raw : null;
      const text = children(n);
      const norm = (s: string) => s.replace("http://", "").replace(/\/+$/, "");
      return href && href.trim() && norm(text) !== norm(href) ? `${text} (${href})` : text;
    }
    case "p":
    case "div":
      return children(n) + NL + NL;
    case "br":
      return NL;
    case "ol":
    case "ul": {
      let i = 1;
      let out = "";
      for (const c of n.children) {
        if (isTag(c) && c.name.toLowerCase() === "li") out += n.name.toLowerCase() === "ol" ? `${i++}. ` : "* ";
        out += isTag(c) ? c.children.map(node).join("") : "";
        out += NL;
      }
      return out + NL;
    }
    default:
      return children(n);
  }
}
