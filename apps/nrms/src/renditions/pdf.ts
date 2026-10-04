import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { LANG_EN, type ReleaseView } from "@gcpe/nrms-contract";
import { htmlToText } from "../text/html-to-text";
import { buildRenditionModel, type RenditionOptions } from "./model";
import { contactsHeading, titleLines } from "./text";

export interface PdfOptions extends RenditionOptions {
  /** The first document's page image (legacy banner), when it has one. */
  pageImage?: { bytes: Buffer; mimeType: string } | null;
}

const PAGE = { width: 612, height: 792 }; // US Letter
const MARGIN = 54;
const BODY_SIZE = 11;
const TITLE_SIZE = 14;
const LEADING = 1.35;
const WIDTH = PAGE.width - 2 * MARGIN;

/**
 * The PDF version: the same content and order as the text version, set in the standard
 * Helvetica faces. pdf-lib embeds the standard-font metrics in its own code (no font files on
 * disk), which is what lets this run from the single-file SiteGround bundle.
 */
export async function renderPdf(v: ReleaseView, opts: PdfOptions): Promise<Buffer> {
  const m = buildRenditionModel(v, opts);
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const english = m.docs.find((d) => d.languageId === LANG_EN) ?? m.docs[0];
  if (english) pdf.setTitle(english.headline);

  const writer = new Writer(pdf);
  const image = opts.pageImage ? await embedImage(pdf, opts.pageImage) : null;
  if (image) writer.image(image);

  const first = m.docs[0];
  writer.lines([m.isReleased ? "For Immediate Release" : null, first?.referenceNumber ?? null, m.releaseDate], regular, BODY_SIZE);
  writer.gap();
  if (first?.organizations) {
    writer.lines(first.organizations.split(/\r?\n/), regular, BODY_SIZE);
    writer.gap();
  }
  for (const [i, d] of m.docs.entries()) {
    if (i > 0) writer.gap(2);
    const [pageTitle, headline] = titleLines(d);
    writer.lines([pageTitle!], bold, TITLE_SIZE);
    if (headline !== undefined) writer.lines([headline], bold, BODY_SIZE + 2);
    writer.lines(d.subheadlineLines, regular, BODY_SIZE);
    writer.gap();
    for (const para of paragraphs(htmlToText(d.bodyHtml))) {
      writer.lines(para.split("\r\n"), regular, BODY_SIZE);
      writer.gap();
    }
    if (d.contacts.length) {
      writer.lines([contactsHeading(d)], bold, BODY_SIZE);
      for (const c of d.contacts) {
        writer.gap();
        writer.lines(c.replace(/\r/g, "").split("\n"), regular, BODY_SIZE);
      }
    }
  }
  return Buffer.from(await pdf.save());
}

/** Body text split into paragraphs on blank lines (whitespace-only lines count as blank). */
function paragraphs(text: string): string[] {
  return text
    .split(/\r\n[ \t ]*\r\n/)
    .map((p) => p.replace(/^(\r\n)+|(\r\n)+$/g, ""))
    .filter((p) => p.trim() !== "");
}

async function embedImage(pdf: PDFDocument, img: { bytes: Buffer; mimeType: string }): Promise<PDFImage | null> {
  try {
    if (img.mimeType === "image/png") return await pdf.embedPng(img.bytes);
    if (img.mimeType === "image/jpeg" || img.mimeType === "image/jpg") return await pdf.embedJpg(img.bytes);
  } catch {
    // A corrupt banner must not stop the release's PDF; it's printed without it.
  }
  return null;
}

/** Top-down text layout with wrapping and page breaks. */
class Writer {
  private page: PDFPage;
  private y: number;
  private readonly encodable = new Map<PDFFont, Set<number>>();

  constructor(private readonly pdf: PDFDocument) {
    this.page = pdf.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - MARGIN;
  }

  image(img: PDFImage): void {
    const scale = Math.min(1, WIDTH / img.width, PAGE.height / 4 / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    this.page.drawImage(img, { x: MARGIN, y: this.y - h, width: w, height: h });
    this.y -= h + BODY_SIZE * LEADING;
  }

  gap(n = 1): void {
    this.y -= BODY_SIZE * LEADING * n;
  }

  /** Draws each line (null lines are skipped), wrapped to the text width. */
  lines(lines: (string | null)[], font: PDFFont, size: number): void {
    for (const line of lines) {
      if (line === null) continue;
      for (const row of this.wrap(this.safe(line, font), font, size)) {
        const lh = size * LEADING;
        if (this.y - lh < MARGIN) {
          this.page = this.pdf.addPage([PAGE.width, PAGE.height]);
          this.y = PAGE.height - MARGIN;
        }
        this.y -= lh;
        if (row) this.page.drawText(row, { x: MARGIN, y: this.y + (lh - size) / 2, size, font, color: rgb(0, 0, 0) });
      }
    }
  }

  /** Characters the standard font can't encode (outside WinAnsi) become "?". */
  private safe(s: string, font: PDFFont): string {
    let set = this.encodable.get(font);
    if (!set) this.encodable.set(font, (set = new Set(font.getCharacterSet())));
    let out = "";
    for (const ch of s.replace(/\t/g, " ")) out += set.has(ch.codePointAt(0)!) ? ch : "?";
    return out;
  }

  private wrap(s: string, font: PDFFont, size: number): string[] {
    const fits = (t: string) => font.widthOfTextAtSize(t, size) <= WIDTH;
    const rows: string[] = [];
    let row = "";
    for (const word of s.split(/ +/)) {
      const next = row ? `${row} ${word}` : word;
      if (fits(next)) {
        row = next;
        continue;
      }
      if (row) rows.push(row);
      row = word;
      // A single word wider than the line is broken by character.
      while (!fits(row)) {
        let cut = row.length - 1;
        while (cut > 1 && !fits(row.slice(0, cut))) cut--;
        rows.push(row.slice(0, cut));
        row = row.slice(cut);
      }
    }
    rows.push(row);
    return rows;
  }
}
