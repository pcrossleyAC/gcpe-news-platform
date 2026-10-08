import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lookAheadDays, makeFixture } from "./fixture.mjs";
import { eventsDayHtml, lookAheadHtml, PAGE, planningHtml } from "./templates.mjs";
import { renderPdfmake } from "./render-pdfmake.mjs";
import { renderDocx } from "./render-docx.mjs";
import { patchDocx } from "./patch-docx.mjs";
import { measure } from "./measure.mjs";

// The converters without a browser read inline styles and classes, not a <style> sheet. This
// variant inlines the three stylesheet-only requirements (header cell colour, alternating row
// shading, a page break before each day) to separate what the converters can't do from what
// the shared template merely didn't tell them.
const inline = (html, headerColour) =>
  html
    .replaceAll("<th>", `<th style="background-color:${headerColour};color:#ffffff">`)
    .replace(/<tbody>(.*?)<\/tbody>/gs, (_, rows) => {
      let i = 0;
      return `<tbody>${rows.replace(/<tr>(.*?)<\/tr>/gs, (__, cells) => (++i % 2 === 0 ? `<tr>${cells.replaceAll("<td>", '<td style="background-color:#f2f2f2">')}</tr>` : `<tr>${cells}</tr>`))}</tbody>`;
    })
    .replaceAll('<section class="day"><h2>', '<section class="day"><h2 class="page-break" style="page-break-before:always">');

// turbodocx swaps width and height for a landscape section, so it is given portrait-ordered twips.
const DOCX_PAGE = { letter: PAGE.letter.docx, legal: { orientation: "landscape", pageSize: { width: 12240, height: 20160 } } };
const pageBreakBefore = (node) => Array.isArray(node.style) && node.style.includes("page-break");

export async function runVariant({ outDir, repeat = 5 }) {
  mkdirSync(outDir, { recursive: true });
  const activities = makeFixture();
  const days = lookAheadDays(activities, { days: 60 });
  const busiest = days.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
  const samples = [
    ["events-day", "letter", inline(eventsDayHtml("letter", busiest), "#558abd")],
    ["events-day", "legal", inline(eventsDayHtml("legal", busiest), "#558abd")],
    ["planning", "legal", inline(planningHtml("legal", activities.slice(0, 40)), "#384c70")],
    ["look-ahead-60", "letter", inline(lookAheadHtml("letter", "Monday, Nov. 2, 2026 to Thursday, Dec. 31, 2026", days), "#558abd")],
  ];
  const results = [];
  for (const [name, size, html] of samples) {
    const approaches = {
      "pdf-pdfmake": async () => ({ kind: "pdf", bytes: await renderPdfmake(html, size, { pageBreakBefore }) }),
      "docx-patched": async () => ({ kind: "docx", bytes: await patchDocx(await renderDocx(html, size, DOCX_PAGE[size])) }),
    };
    for (const [approach, fn] of Object.entries(approaches)) {
      const runs = [];
      for (let i = 0; i < repeat + 1; i++) {
        let last;
        runs.push(await measure(`${name}/${size}/${approach}`, async () => (last = await fn())));
        if (i === 0) writeFileSync(join(outDir, `${name}.${size}.${approach}.${last.kind}`), last.bytes);
      }
      const timed = runs.slice(1).map((r) => r.ms).sort((a, b) => a - b);
      results.push({ sample: name, size, approach, first: runs[0], medianMs: timed[Math.floor(timed.length / 2)] });
    }
  }
  writeFileSync(join(outDir, "results.variant.json"), JSON.stringify(results, null, 2));
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await runVariant({ outDir: join(process.cwd(), "out", process.argv[2] ?? "local-inline") }), null, 2));
}
