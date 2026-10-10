/**
 * A report as a renderer-neutral document: plain data, so it crosses into the rendering worker
 * by structured clone, and any renderer behind PdfRenderer (pdfmake today; a browser on a container
 * host later) draws the same thing. Builders choose every colour and break; renderers only draw.
 */

/** A run of text. A "\n" inside `text` breaks the line. */
export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** "#rrggbb". */
  color?: string;
  /** Points; the document's 9 pt otherwise. */
  size?: number;
  /** An absolute http(s) URL. */
  link?: string;
}

export interface Cell {
  runs: Run[];
  /** Background, "#rrggbb". */
  fill?: string;
  align?: "left" | "center" | "right";
}

export interface HeadingBlock {
  kind: "heading";
  runs: Run[];
  size: number;
  align?: "left" | "center";
  /** Space above, in points. */
  spaceBefore?: number;
}

export interface TableBlock {
  kind: "table";
  /** Points, or "*" for the rest of the line. */
  widths: (number | "*")[];
  /** Repeated at the top of every page the table runs onto. */
  header: Cell[];
  rows: Cell[][];
}

/** The Look Ahead's cover banner: the organization's name above the report's name, white on dark grey. */
export interface BannerBlock {
  kind: "banner";
  organization: string;
  lines: string[];
}

/** The cover's "Contents:" legend. */
export interface LegendBlock {
  kind: "legend";
  items: { colour: string; runs: Run[] }[];
}

export interface PageBreakBlock {
  kind: "pageBreak";
}

export type Block = HeadingBlock | TableBlock | BannerBlock | LegendBlock | PageBreakBlock;

/** Running text at one edge of the page. */
export interface Running {
  left?: Run[];
  center?: Run[];
  right?: Run[];
  /** "Page X of Y" at the right. */
  pageNumbers?: boolean;
}

export interface ReportDoc {
  page: "letter-portrait" | "legal-landscape";
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
