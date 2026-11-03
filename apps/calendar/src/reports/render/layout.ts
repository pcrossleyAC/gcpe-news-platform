import type { Content, ContextPageSize, CustomTableLayout, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { cm, inch, type Block, type Cell, type CoverBlock, type HeadingBlock, type ImageRef, type ReportDoc, type Run, type Running, type TableBlock } from "../model";

export const FONT = "BCSans";

/** A zero-width space after the hyphen: line breaking forbids a break between a hyphen and a digit, so pdfmake would break inside the number. */
const ZWSP = "\u200B";

function textOf(runs: Run[]) {
  if (runs.length === 0) return "";
  return runs.map((r) => ({
    text: r.wrapAtHyphen ? r.text.replaceAll("-", `-${ZWSP}`) : r.text,
    ...(r.bold ? { bold: true } : {}),
    ...(r.italic ? { italics: true } : {}),
    ...(r.underline ? { decoration: "underline" as const } : {}),
    ...(r.color ? { color: r.color } : {}),
    ...(r.size ? { fontSize: r.size } : {}),
    ...(r.link ? { link: r.link } : {}),
  }));
}

const cellOf = (c: Cell) => ({
  text: textOf(c.runs),
  ...(c.fill ? { fillColor: c.fill } : {}),
  ...(c.align ? { alignment: c.align } : {}),
  ...(c.paddingBottom ? { margin: [0, 0, 0, c.paddingBottom] as [number, number, number, number] } : {}),
});

const headingOf = (h: Omit<HeadingBlock, "kind">) => ({
  text: textOf(h.runs),
  fontSize: h.size,
  alignment: h.align ?? "left",
  margin: [0, h.spaceBefore ?? 4, 0, h.spaceAfter ?? 4] as [number, number, number, number],
  // Legacy's DocumentMapLabel: pdfmake adds the bookmark for the heading's first line.
  ...(h.bookmark ? { outline: true, outlineText: h.bookmark } : {}),
});

/**
 * A table whose titles are header rows too, so pdfmake repeats them with the column header on every
 * page the table runs onto, as legacy's RepeatOnNewPage rows: drawn without lines or padding.
 */
function tableOf(b: TableBlock): Content {
  const titles = b.titles ?? [];
  const t = titles.length;
  const n = b.widths.length;
  const g = b.grid;
  // A repeated row would repeat its bookmark on every page: the first row carries it instead, as a line of no height.
  const bookmark = b.rows.length ? titles.find((h) => h.bookmark)?.bookmark : undefined;
  const titleRows: TableCell[][] = titles.map((h) => [
    { ...headingOf(bookmark ? { ...h, bookmark: undefined } : h), colSpan: n, border: [false, false, false, false] },
    ...Array.from({ length: n - 1 }, () => ({ text: "" })),
  ]);
  const rows = b.rows.map((r) => r.map(cellOf) as TableCell[]);
  if (bookmark) {
    const { text, ...style } = cellOf(b.rows[0]![0]!);
    rows[0]![0] = { ...style, stack: [{ text: ZWSP, fontSize: 1, lineHeight: 0.01, outline: true, outlineText: bookmark }, { text }] } as TableCell;
  }
  const hc = g.headerColour;
  const header = b.header.map((c) => ({ ...cellOf(c), ...(hc ? { borderColor: [hc, hc, hc, hc] } : {}) }));
  const layout: CustomTableLayout = {
    hLineWidth: (i) => (i < t ? 0 : g.width),
    vLineWidth: () => g.width,
    hLineColor: (i) => (hc && (i === t || i === t + 1) ? hc : g.colour),
    vLineColor: () => g.colour,
    paddingLeft: () => g.padding,
    paddingRight: () => g.padding,
    paddingTop: (i) => (i < t ? 0 : g.padding),
    paddingBottom: (i) => (i < t ? 0 : g.padding),
  };
  return {
    // pdfmake's widths are the text's, padding and lines outside them (and it rewrites the array in place).
    table: { headerRows: t + 1, keepWithHeaderRows: 1, dontBreakRows: true, widths: b.widths.map((w) => (w === "*" ? w : w - 2 * g.padding - g.width)), body: [...titleRows, header as TableCell[], ...rows] },
    layout,
    margin: [0, 0, 0, 6],
  };
}

/**
 * LookAheadLegendSubreport.rdlc, at its place in the cover (Top 7in, Left 0.5in): a 0.39 in title row,
 * a 0.28 in "Contents:" row, then 0.31 in rows of a swatch inside a 0.3 cm white border and the
 * section's name, 10 pt in and 5 pt down.
 */
const LEGEND = { left: inch(0.5), top: inch(7), widths: [inch(0.3937), inch(5.90551)], titleRow: inch(0.3937), contentsRow: inch(0.27559), itemRow: inch(0.31496), inset: cm(0.3) / 2 };

function coverOf(b: CoverBlock, doc: ReportDoc): Content[] {
  const [left, top] = doc.margins;
  const out: Content[] = [];
  // LookAheadReport.rdlc's RectangleCoverPage: the picture as its background at 96 ppi, clipped by the page.
  if (b.image) out.push({ image: b.image.name, width: b.image.width, height: b.image.height, absolutePosition: { x: left, y: top } });
  else {
    out.push({
      table: {
        widths: ["*"],
        body: [[{
          stack: [{ text: b.organization, fontSize: 13, bold: true, color: "#d9d9d9", margin: [0, 0, 0, 8] }, ...b.lines.map((l) => ({ text: l, fontSize: 26, color: "#ffffff" }))],
          fillColor: "#595959",
          margin: [180, 60, 16, 60],
        }]],
      },
      layout: "noBorders",
    });
  }
  const swatch = LEGEND.widths[0]!;
  const span = (c: object): TableCell[] => [{ ...c, colSpan: 2 } as TableCell, { text: "" }];
  out.push({
    absolutePosition: { x: left + LEGEND.left, y: top + LEGEND.top },
    table: {
      widths: [...LEGEND.widths],
      heights: [LEGEND.titleRow, LEGEND.contentsRow, ...b.legend.map(() => LEGEND.itemRow)],
      body: [
        // BC Sans's lines are taller than Calibri's: the filter line is set tight so the row keeps legacy's height.
        span({ stack: [{ text: textOf(b.title), fontSize: 14 }, ...(b.filter ? [{ text: textOf(b.filter), fontSize: 9, lineHeight: 0.75 }] : [])] }),
        span({ text: textOf(b.contents), fontSize: 14 }),
        ...b.legend.map((i): TableCell[] => [
          { canvas: [{ type: "rect", x: 0, y: 0, w: swatch - 2 * LEGEND.inset, h: LEGEND.itemRow - 2 * LEGEND.inset, color: i.colour }], margin: [LEGEND.inset, LEGEND.inset, 0, 0] },
          { text: textOf(i.runs), fontSize: 12, margin: [10, 5, 0, 0] },
        ]),
      ],
    },
    layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0 },
  });
  return out;
}

function contentOf(b: Exclude<Block, { kind: "pageBreak" }>, doc: ReportDoc): Content[] {
  switch (b.kind) {
    case "heading":
      return [headingOf(b)];
    case "table":
      return [tableOf(b)];
    case "cover":
      return coverOf(b, doc);
  }
}

const imageOf = (i: ImageRef) => ({ image: i.name, width: i.width, height: i.height });

/** Every image the document draws, by name, for pdfmake's images dictionary: the worker puts their bytes in its virtual file store. */
export function imagesOf(doc: ReportDoc): string[] {
  const refs = [doc.header?.image, doc.footer?.image, doc.firstPage?.header?.image, doc.firstPage?.footer?.image, ...doc.blocks.map((b) => (b.kind === "cover" ? b.image : null))];
  return [...new Set(refs.filter((r): r is ImageRef => !!r).map((r) => r.name))];
}

/**
 * Running text's line height, as a share of BC Sans's own (1.36 em, against Calibri's 1.22): pdfmake leaves
 * out a header or footer taller than its margin, and legacy's margins were sized for Calibri. The glyphs
 * stay where they are; only the line's measured height, and so a second line's distance, shrinks.
 */
const RUNNING_LINE_HEIGHT = 0.85;

function runningOf(r: Running | null, page: number, pages: number, doc: ReportDoc): Content {
  if (!r) return "";
  const [left, , right] = doc.margins;
  const pad = r.padding ?? 0;
  const rightRuns = [...textOf(r.right ?? []), ...(r.pageNumbers ? [{ text: `Page ${page} of ${pages}` }] : [])];
  const rightTop = (r.rightOffset ?? r.offset) - r.offset;
  return {
    columns: [
      r.image ? { ...imageOf(r.image), width: r.image.width } : { text: textOf(r.left ?? []), width: "auto", margin: [pad, pad, pad, 0] },
      { text: rightRuns.length ? rightRuns : "", width: "*", alignment: "right", margin: [pad, pad + rightTop, pad, 0] },
    ],
    columnGap: 0,
    fontSize: r.size,
    lineHeight: RUNNING_LINE_HEIGHT,
    margin: [left, r.offset, right, 0],
  };
}

/** A report document as pdfmake's document definition. Pure: tests read it without rendering. */
export function docDefinitionOf(doc: ReportDoc): TDocumentDefinitions {
  const content: Content[] = [];
  let breakNext = false;
  for (const b of doc.blocks) {
    if (b.kind === "pageBreak") {
      breakNext = content.length > 0;
      continue;
    }
    const nodes = contentOf(b, doc);
    if (breakNext) (nodes[0] as Content & { pageBreak?: "before" }).pageBreak = "before";
    breakNext = false;
    content.push(...nodes);
  }
  const first = doc.firstPage;
  const images = imagesOf(doc);
  return {
    info: { title: doc.title },
    pageSize: doc.page === "legal-landscape" ? "LEGAL" : "LETTER",
    pageOrientation: doc.page === "legal-landscape" ? "landscape" : "portrait",
    pageMargins: [...doc.margins],
    defaultStyle: { font: FONT, fontSize: doc.fontSize },
    ...(images.length ? { images: Object.fromEntries(images.map((n) => [n, n])) } : {}),
    header: (page: number, pages: number, _size: ContextPageSize) => runningOf(page === 1 && first ? first.header : doc.header, page, pages, doc),
    footer: (page: number, pages: number) => runningOf(page === 1 && first ? first.footer : doc.footer, page, pages, doc),
    content,
  };
}
