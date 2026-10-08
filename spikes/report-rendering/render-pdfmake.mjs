import { JSDOM } from "jsdom";
import htmlToPdfmake from "html-to-pdfmake";
import PdfPrinter from "pdfmake";
import { PAGE, RUNNING } from "./templates.mjs";

// pdfkit's standard 14 fonts: no font files to ship (the same reason NRMS's PDFs use pdf-lib's).
const printer = new PdfPrinter({ Helvetica: { normal: "Helvetica", bold: "Helvetica-Bold", italics: "Helvetica-Oblique", bolditalics: "Helvetica-BoldOblique" } });

/** The same HTML, without a browser: html-to-pdfmake's DOM walk, pdfmake's layout. */
export async function renderPdfmake(html, size, extra = {}) {
  const { window } = new JSDOM("");
  const body = html.replace(/^.*<body>|<\/body>.*$/gs, "").replace(/<img[^>]*>/g, ""); // SVG data URIs are out of scope for this path
  const content = htmlToPdfmake(body, { window, tableAutoSize: true });
  const docDef = {
    ...PAGE[size].pdfmake,
    pageMargins: [36, 60, 36, 50],
    defaultStyle: { font: "Helvetica", fontSize: 9 },
    header: (current) => ({ text: current === 1 ? RUNNING.firstHeader : RUNNING.header, alignment: "right", margin: [36, 20, 36, 0], fontSize: 8 }),
    footer: (current, total) => ({ columns: [{ text: RUNNING.footerLeft, fontSize: 8 }, { text: `Page ${current} of ${total}`, alignment: "right", fontSize: 8 }], margin: [36, 10, 36, 0] }),
    content,
    ...extra,
  };
  const pdf = printer.createPdfKitDocument(docDef);
  const chunks = [];
  return new Promise((resolve, reject) => {
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
    pdf.end();
  });
}
