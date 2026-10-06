import { LANG_EN, type ReleaseView } from "@gcpe/nrms-contract";
import { htmlToText } from "../text/html-to-text";
import { asciiPunctuation, collapseBlankLines } from "../text/plain";
import { buildRenditionModel, type RenditionDoc, type RenditionOptions } from "./model";

const NL = "\r\n";
export const TEXT_FOOTER = "Connect with the Province of B.C. at: http://news.gov.bc.ca/connect";

/** Plain text with CRLF line endings. */
const crlf = (s: string) => s.replace(/\r/g, "").replace(/\n/g, NL);

export function contactsHeading(d: RenditionDoc): string {
  if (d.languageId !== LANG_EN) return "Renseignements additionnels:";
  return d.contacts.length === 1 ? "Contact:" : "Contacts:";
}

/** Legacy "funky" special case: a Media Advisory shows only its page title. */
export function titleLines(d: RenditionDoc): string[] {
  return d.pageTitle === "Media Advisory" ? [d.pageTitle.toUpperCase()] : [d.pageTitle.toUpperCase(), d.headline];
}

/** Port of legacy Release.ToTextDocumentAsString: the same body as {@link renderText}, but
 * without its trailing TEXT_FOOTER -- the real media-email sample ends at the contact block.
 * `renderText` (the .txt download and "email me a copy") adds the footer on top of this. */
export function renderTextBody(v: ReleaseView, opts: RenditionOptions): string {
  const m = buildRenditionModel(v, opts);
  const first = m.docs[0];
  let docs = "";
  for (const d of m.docs) {
    const contacts = d.contacts.length ? contactsHeading(d) + d.contacts.map((c) => NL + NL + crlf(c)).join("") : "";
    docs +=
      NL + NL +
      titleLines(d).join(NL) + NL +
      d.subheadlineLines.join(NL) + NL +
      NL +
      htmlToText(d.bodyHtml) + NL +
      NL +
      contacts;
  }
  const package_ =
    (m.isReleased ? "For Immediate Release" + NL : "") + (first?.referenceNumber ?? "") + NL +
    m.releaseDate + NL +
    NL +
    crlf(first?.organizations ?? "") + NL +
    NL +
    docs;
  return asciiPunctuation(collapseBlankLines(package_));
}

/** Port of legacy Release.ToTextDocument (ReleaseText.txt + DocumentText.txt templates): the
 * .txt download and "email me a copy" version, which is {@link renderTextBody} plus the fixed
 * TEXT_FOOTER. */
export function renderText(v: ReleaseView, opts: RenditionOptions): string {
  return renderTextBody(v, opts) + NL + NL + NL + TEXT_FOOTER;
}
