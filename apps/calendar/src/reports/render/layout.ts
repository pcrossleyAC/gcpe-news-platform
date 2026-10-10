import type { Content, ContextPageSize, CustomTableLayout, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import type { Block, Cell, ReportDoc, Run, Running } from "../model";

export const FONT = "BCSans";
const MARGIN = 36;
const GRID: CustomTableLayout = {
  hLineWidth: () => 0.5,
  vLineWidth: () => 0.5,
  hLineColor: () => "#bfbfbf",
  vLineColor: () => "#bfbfbf",
  paddingLeft: () => 3,
  paddingRight: () => 3,
  paddingTop: () => 2,
  paddingBottom: () => 2,
};
const NONE: CustomTableLayout = { hLineWidth: () => 0, vLineWidth: () => 0 };

function textOf(runs: Run[]) {
  if (runs.length === 0) return "";
  return runs.map((r) => ({
    text: r.text,
    ...(r.bold ? { bold: true } : {}),
    ...(r.italic ? { italics: true } : {}),
    ...(r.underline ? { decoration: "underline" as const } : {}),
    ...(r.color ? { color: r.color } : {}),
    ...(r.size ? { fontSize: r.size } : {}),
    ...(r.link ? { link: r.link } : {}),
  }));
}

const cellOf = (c: Cell): TableCell => ({ text: textOf(c.runs), ...(c.fill ? { fillColor: c.fill } : {}), ...(c.align ? { alignment: c.align } : {}) });

function contentOf(b: Exclude<Block, { kind: "pageBreak" }>): Content {
  switch (b.kind) {
    case "heading":
      return { text: textOf(b.runs), fontSize: b.size, alignment: b.align ?? "left", margin: [0, b.spaceBefore ?? 4, 0, 4] };
    case "table":
      return { table: { headerRows: 1, dontBreakRows: true, widths: b.widths, body: [b.header.map(cellOf), ...b.rows.map((r) => r.map(cellOf))] }, layout: GRID, margin: [0, 0, 0, 6] };
    case "banner":
      return {
        table: {
          widths: ["*"],
          body: [[{
            stack: [{ text: b.organization, fontSize: 13, bold: true, color: "#d9d9d9", margin: [0, 0, 0, 8] }, ...b.lines.map((l) => ({ text: l, fontSize: 26, color: "#ffffff" }))],
            fillColor: "#595959",
            margin: [180, 60, 16, 60],
          }]],
        },
        layout: NONE,
      };
    case "legend":
      return {
        table: { widths: [18, "*"], body: b.items.map((i) => [{ text: "", fillColor: i.colour }, { text: textOf(i.runs), fontSize: 10 }]) },
        layout: { ...NONE, paddingTop: () => 3, paddingBottom: () => 3, paddingLeft: () => 6, paddingRight: () => 6 },
        margin: [0, 4, 0, 0],
      };
  }
}

function runningOf(r: Running | null, page: number, pages: number): Content {
  if (!r) return "";
  const right = r.pageNumbers ? `Page ${page} of ${pages}` : textOf(r.right ?? []);
  return {
    columns: [
      { text: textOf(r.left ?? []), width: "*" },
      { text: textOf(r.center ?? []), width: "auto", alignment: "center" },
      { text: right, width: "auto", alignment: "right" },
    ],
    columnGap: 8,
    fontSize: 8,
    margin: [MARGIN, 16, MARGIN, 0],
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
    const node = contentOf(b) as Content & { pageBreak?: "before" };
    if (breakNext) node.pageBreak = "before";
    breakNext = false;
    content.push(node);
  }
  const first = doc.firstPage;
  return {
    info: { title: doc.title },
    pageSize: doc.page === "legal-landscape" ? "LEGAL" : "LETTER",
    pageOrientation: doc.page === "legal-landscape" ? "landscape" : "portrait",
    pageMargins: [MARGIN, 54, MARGIN, 44],
    defaultStyle: { font: FONT, fontSize: 9 },
    header: (page: number, pages: number, _size: ContextPageSize) => runningOf(page === 1 && first ? first.header : doc.header, page, pages),
    footer: (page: number, pages: number) => runningOf(page === 1 && first ? first.footer : doc.footer, page, pages),
    content,
  };
}
