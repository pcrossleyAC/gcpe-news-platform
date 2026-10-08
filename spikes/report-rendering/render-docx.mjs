import HTMLtoDOCX from "@turbodocx/html-to-docx";
import { PAGE, RUNNING } from "./templates.mjs";

/** The same HTML → DOCX. The footer carries {PAGE}/{NUMPAGES} markers for patch-docx.mjs. */
export async function renderDocx(html, size, page = PAGE[size].docx) {
  const body = html.replace(/^.*<body>|<\/body>.*$/gs, "");
  const buf = await HTMLtoDOCX(
    body,
    `<p style="text-align:right">${RUNNING.header}</p>`,
    { ...page, header: true, footer: true, pageNumber: false, margins: { top: 1296, bottom: 1152, left: 720, right: 720, header: 576, footer: 576 } },
    `<p>${RUNNING.footerLeft} — Page {PAGE} of {NUMPAGES}</p>`,
  );
  return Buffer.from(buf);
}
