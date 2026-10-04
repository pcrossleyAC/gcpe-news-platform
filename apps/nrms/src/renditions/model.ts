import { parseDocument } from "htmlparser2";
import { isTag, isText, Text, type ChildNode, type Element } from "domhandler";
import render from "dom-serializer";
import { LANG_EN, LANG_FR, type LanguageId, type ReleaseView } from "@gcpe/nrms-contract";

/** One document in one language, as the legacy Templates.Document saw it (Release.FromEntity). */
export interface RenditionDoc {
  languageId: LanguageId;
  pageTitle: string;
  headline: string;
  subheadlineLines: string[];
  bylineHtml: string | null;
  /** Location merged, asset tags stripped, empty paragraphs removed (and the informal byline prefix). */
  bodyHtml: string;
  organizations: string | null;
  contacts: string[];
  referenceNumber: string | null;
  pageImageId: string | null;
}

export interface RenditionModel {
  isReleased: boolean;
  /** CP style, BC time. */
  releaseDate: string;
  docs: RenditionDoc[];
}

export interface RenditionOptions {
  timeZone: string;
  nowMs: number;
}

const LOCATION_SEPARATOR = " – ";
const FRENCH_NOTE = "(disponible en français en bas de page)";
const ASSET = /<asset>[^<]+<\/asset>/g;
// .NET "MMM." followed by legacy CPDateFormat's replacements.
const CP_MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];

/** Legacy Release.CPDateFormat: "MMM. d, yyyy" in the tenant's time zone, Canadian Press months. */
export function cpDate(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return `${CP_MONTHS[get("month") - 1]} ${get("day")}, ${get("year")}`;
}

const escapeText = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const innerText = (n: ChildNode): string => (isText(n) ? n.data : isTag(n) ? n.children.map(innerText).join("") : "");

/**
 * Legacy Release.MergeLocationBody: "LOCATION – " goes before the first child (other than an
 * <asset>) of the first top-level <p> that has one; a non-empty top-level list before that
 * leaves the body untouched. Entities are neither decoded nor re-encoded, so the rest of the
 * body comes back as written.
 */
export function mergeLocation(location: string, bodyHtml: string): string {
  if (location.trim() === "") return bodyHtml;
  const doc = parseDocument(bodyHtml, { decodeEntities: false });
  for (const node of doc.children) {
    if (!isTag(node)) continue;
    const name = node.name.toLowerCase();
    if (name === "p") {
      const child = node.children.find((c) => !(isTag(c) && c.name.toLowerCase() === "asset"));
      if (!child) continue;
      insertBefore(node, child, new Text(escapeText(location.toUpperCase() + LOCATION_SEPARATOR)));
      return render(doc, { decodeEntities: false });
    }
    if ((name === "ul" || name === "ol") && innerText(node).replaceAll("&nbsp;", " ").trim() !== "") return bodyHtml;
  }
  return bodyHtml;
}

function insertBefore(parent: Element, before: ChildNode, node: Text): void {
  const i = parent.children.indexOf(before);
  node.parent = parent;
  node.prev = before.prev;
  node.next = before;
  if (before.prev) before.prev.next = node;
  before.prev = node;
  parent.children.splice(i, 0, node);
}

function referenceNumber(v: ReleaseView): string | null {
  if (v.type === "advisory") return null;
  if (!v.reference || !v.leadMinistryKey) return "Not Approved";
  return v.type === "release" ? v.key : v.reference;
}

const lines = (s: string | null) => (s ? s.replace(/\r/g, "").split(/\n|<br\s*\/?>/i) : []);

/** Port of legacy Release.FromEntity (the parts the text and PDF versions use). */
export function buildRenditionModel(v: ReleaseView, opts: RenditionOptions): RenditionModel {
  const releaseAt = v.releasedAt ?? v.publishAt;
  const reference = referenceNumber(v);
  const location = (lang: LanguageId) => {
    const own = v.languages.find((l) => l.languageId === lang)?.location ?? "";
    return own || (v.languages.find((l) => l.languageId === LANG_EN)?.location ?? "");
  };
  const documents = [...v.documents].sort((a, b) => a.sortIndex - b.sortIndex);
  const firstDocId = documents[0]?.id;
  const docs: RenditionDoc[] = [];
  for (const lang of [LANG_EN, LANG_FR] as const) {
    for (const d of documents) {
      const dl = d.languages.find((l) => l.languageId === lang);
      if (!dl) continue;
      const subheadlineLines = lines(dl.subheadline);
      if (lang === LANG_EN && d.languages.length > 1) subheadlineLines.push(FRENCH_NOTE);
      const bylineHtml = dl.byline ? dl.byline.replace(/\r/g, "").replace(/\n/g, "<br />") : null;
      let body = mergeLocation(d.id === firstDocId ? location(lang) : "", dl.bodyHtml)
        .replace(ASSET, "")
        .replaceAll("<p>&nbsp;</p>", "")
        .replaceAll("<p></p>", "");
      if (d.layout === "informal") body = "&nbsp;<br />" + (bylineHtml ? `<b>${bylineHtml}</b>` : "") + "<br /><br /><br /><br />" + body;
      docs.push({
        languageId: lang,
        pageTitle: dl.pageTitle,
        headline: dl.headline,
        subheadlineLines,
        bylineHtml,
        bodyHtml: body,
        organizations: dl.organizations,
        contacts: dl.contacts,
        referenceNumber: reference,
        pageImageId: dl.pageImageId,
      });
    }
  }
  return {
    isReleased: !!v.reference,
    releaseDate: cpDate(releaseAt ? new Date(releaseAt) : new Date(opts.nowMs), opts.timeZone),
    docs,
  };
}
