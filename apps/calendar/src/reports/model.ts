/**
 * A report as a renderer-neutral document: plain data, so it crosses into the rendering worker
 * by structured clone, and any renderer behind PdfRenderer (pdfmake today; a browser on a container
 * host later) draws the same thing. Builders choose every colour, size, margin and break; renderers only draw.
 */

/** A run of text. A "\n" inside `text` breaks the line. */
export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** "#rrggbb". */
  color?: string;
  /** Points; the document's `fontSize` otherwise. */
  size?: number;
  /** An absolute http(s) URL. */
  link?: string;
  /** May break after a hyphen when it doesn't fit, as legacy's did ("HLTH-" over "20001", "10:30-" over "11:00 AM"); never between digits. */
  wrapAtHyphen?: boolean;
}

/**
 * An image the tenant supplies (lookAheadCoverImage, lookAheadLogoImage): a bare file name in the
 * report images folder (render/assets.ts), drawn at its size in points.
 */
export interface ImageRef {
  name: string;
  width: number;
  height: number;
}

export interface Cell {
  runs: Run[];
  /** Background, "#rrggbb". */
  fill?: string;
  align?: "left" | "center" | "right";
  /** Space under the text, in points, where it is more than the table's padding (legacy's 8 pt under Activity/Details). */
  paddingBottom?: number;
}

export interface HeadingBlock {
  kind: "heading";
  runs: Run[];
  size: number;
  align?: "left" | "center" | "right";
  /** Space above and below, in points. */
  spaceBefore?: number;
  spaceAfter?: number;
  /** An entry in the PDF's bookmarks (legacy's DocumentMapLabel). */
  bookmark?: string;
}

/** A table's lines and padding. */
export interface Grid {
  /** "#rrggbb" and points. */
  colour: string;
  width: number;
  /** The header row's own line colour, where it differs. */
  headerColour?: string;
  /** Points inside every cell, each side. */
  padding: number;
}

export interface TableBlock {
  kind: "table";
  /** Each column's whole width in points, padding and line included, as an RDLC gives it; or "*" for the rest of the line. */
  widths: (number | "*")[];
  /** Headings above the header row, repeated with it at the top of every page the table runs onto (legacy's RepeatOnNewPage rows). */
  titles?: Omit<HeadingBlock, "kind">[];
  /** Repeated at the top of every page the table runs onto. */
  header: Cell[];
  rows: Cell[][];
  grid: Grid;
}

/** One line of the cover's "Contents:" legend: a swatch and the section's name. */
export interface LegendItem {
  colour: string;
  runs: Run[];
}

/**
 * The Look Ahead's cover: the tenant's picture behind the page (legacy's LookAheadCover.jpg, which
 * carries the organization, the report's name and the Questions box), or, without one, a drawn
 * banner with the organization above the report's name; then the title, the filter line, "Contents:"
 * and the legend at legacy's place low on the page.
 */
export interface CoverBlock {
  kind: "cover";
  image: ImageRef | null;
  /** The drawn banner's texts, used only without an image. */
  organization: string;
  lines: string[];
  title: Run[];
  /** Under the title, inside its row, so "Contents:" keeps its place. */
  filter: Run[] | null;
  /** The legend's own heading, "Contents:". */
  contents: Run[];
  legend: LegendItem[];
}

export interface PageBreakBlock {
  kind: "pageBreak";
}

export type Block = HeadingBlock | TableBlock | CoverBlock | PageBreakBlock;

/** Running text at one edge of the page. */
export interface Running {
  /** At the left edge, in place of `left`'s text. */
  image?: ImageRef;
  /** As wide as it needs: legacy's boxes (7 cm, 10 cm) were sized for Calibri, and BC Sans's wider right text would wrap in what they leave. */
  left?: Run[];
  /** Right-aligned in the rest of the line; "Page X of Y" follows it when `pageNumbers` is set. */
  right?: Run[];
  pageNumbers?: boolean;
  /** Points, for any run without its own size and for "Page X of Y". */
  size: number;
  /** Points from the page's top (a header) or from the top of the bottom margin (a footer) to the left box, and to the right one where it differs. */
  offset: number;
  rightOffset?: number;
  /** Points inside each text box (legacy's textbox padding). */
  padding?: number;
}

export interface ReportDoc {
  page: "letter-portrait" | "legal-landscape";
  /** Points from each edge to the body: left, top, right, bottom. The header sits in the top one, the footer in the bottom one. */
  margins: [number, number, number, number];
  /** Body text's size in points. */
  fontSize: number;
  /** The PDF's own title. */
  title: string;
  header: Running | null;
  footer: Running | null;
  /** Page 1's own header and footer, where they differ (the Look Ahead's cover). */
  firstPage?: { header: Running | null; footer: Running | null };
  blocks: Block[];
}

/** The table rows a document holds: what a render costs. */
export function rowCountOf(doc: ReportDoc): number {
  return doc.blocks.reduce((n, b) => n + (b.kind === "table" ? b.rows.length : 0), 0);
}

/** Legacy's RDLC units as points. */
export const inch = (n: number) => n * 72;
export const cm = (n: number) => (n * 72) / 2.54;
