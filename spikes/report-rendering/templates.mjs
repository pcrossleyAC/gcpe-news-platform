// HTML templates in the layouts of docs/parity/legacy-report-layouts.md (pixel-verified colours).
// Running text uses CSS paged-media margin boxes, so one template carries its own page furniture.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmtDay = (d) => d.toLocaleDateString("en-CA", { timeZone: "America/Vancouver", weekday: "long", month: "long", day: "numeric", year: "numeric" });
const UPDATED = "Updated Monday, Nov 2, 2026 8:00 AM";

export const PAGE = {
  letter: { css: "8.5in 11in", pdfmake: { pageSize: "LETTER", pageOrientation: "portrait" }, docx: { orientation: "portrait", pageSize: { width: 12240, height: 15840 } } },
  legal: { css: "14in 8.5in", pdfmake: { pageSize: "LEGAL", pageOrientation: "landscape" }, docx: { orientation: "landscape", pageSize: { width: 20160, height: 12240 } } },
};

function css(size) {
  return `
  @page { size: ${PAGE[size].css}; margin: 0.9in 0.5in 0.8in 0.5in;
    @top-left { content: "Province of BC"; font: 9pt Helvetica, Arial, sans-serif; }
    @top-right { content: "DRAFT AND CONFIDENTIAL"; color: #9e3a38; font: bold 9pt Helvetica, Arial, sans-serif; }
    @bottom-left { content: "${UPDATED}"; font: 8pt Helvetica, Arial, sans-serif; }
    @bottom-center { content: '"CHANGED" applies to major detail or date changes only (not time switches)'; font: 7pt Helvetica, Arial, sans-serif; }
    @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt Helvetica, Arial, sans-serif; } }
  @page :first { @top-right { content: "DRAFT ONLY - NOT FOR CIRCULATION / Information is confidential and subject to change"; color: #000; } @top-left { content: none; } }
  body { font: 9pt Helvetica, Arial, sans-serif; margin: 0; }
  table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th { color: #fff; text-align: left; padding: 3pt; }
  td { padding: 3pt; vertical-align: top; border-bottom: 0.5pt solid #ccc; }
  tbody tr:nth-child(even) td { background: #f2f2f2; }
  .events th { background: #558abd; }
  .planning th { background: #384c70; }
  .day { break-before: page; }
  .day:first-of-type { break-before: auto; }
  h2 { color: #558abd; text-align: center; font-size: 12pt; }
  .flag { color: #e36c09; font-weight: bold; }
  .legend td.swatch { width: 18pt; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }`;
}

const doc = (size, body) => `<!doctype html><html><head><meta charset="utf-8"><style>${css(size)}</style></head><body>${body}</body></html>`;

// A generated placeholder, never legacy's cover photograph (E12).
const COVER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="260"><rect width="600" height="260" fill="#555"/><text x="300" y="140" font-family="Helvetica" font-size="28" fill="#fff" text-anchor="middle">SAMPLE COVER</text></svg>`;
const COVER = `data:image/svg+xml;base64,${Buffer.from(COVER_SVG).toString("base64")}`;

const LEGEND = [
  ["Events, Speeches and Releases (Inside Government)", "#558abd"],
  ["Issues and Reports", "#ccc0d9"],
  ["In the News (Outside Government)", "#e8f3a9"],
  ["Awareness Dates", "#eaf1dd"],
];

export function coverHtml(size, title) {
  const rows = LEGEND.map(([label, colour]) => `<tr><td class="swatch" style="background:${colour}"></td><td>${esc(label)}</td></tr>`).join("");
  return doc(size, `<img src="${COVER}" style="width:100%"><h1 style="text-align:center">${esc(title)}</h1><p><b>Contents:</b></p><table class="legend">${rows}</table>`);
}

function dayTable(day) {
  const head = day.date.toLocaleDateString("en-CA", { timeZone: "America/Vancouver", weekday: "short", month: "short", day: "numeric" });
  const body = day.rows.length
    ? day.rows
        .map((a) => {
          const flag = a.laStatus ? `<div class="flag">${a.laStatus}</div>` : "";
          return `<tr><td>${flag}${a.isAllDay ? "All day" : new Date(a.startAt).toLocaleTimeString("en-CA", { timeZone: "America/Vancouver", hour: "numeric", minute: "2-digit" })}</td><td>${a.ministry}</td><td><b>${esc(a.city)} - ${esc(a.title)}</b>: ${esc(a.details)}</td><td>${a.rls.map(esc).join("<br>")}</td><td>${a.ministry}-${a.id}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="5">No Activities for ${esc(fmtDay(day.date))}</td></tr>`;
  return `<section class="day"><h2>${esc(fmtDay(day.date))}</h2><p><b>Events, Speeches &amp; Releases</b></p><table class="events"><thead><tr><th>${esc(head)}</th><th>Lead</th><th>Activity/Details</th><th>RLS</th><th>CC ID#</th></tr></thead><tbody>${body}</tbody></table></section>`;
}

export function eventsDayHtml(size, day) {
  return doc(size, dayTable(day));
}

/** The whole 60-day Look Ahead body: cover, then one day per page (legacy's HQ rule, simplified to always break). */
export function lookAheadHtml(size, title, days) {
  const cover = coverHtml(size, title).replace(/^.*<body>|<\/body>.*$/gs, "");
  return doc(size, `<section>${cover}</section>${days.map(dayTable).join("")}`);
}

export function planningHtml(size, activities) {
  const rows = activities
    .map(
      (a) =>
        `<tr><td>${esc(new Date(a.startAt).toDateString())}<br>${esc(a.schedule)}${a.premierRequested ? `<br><b style="color:#c0504d">Premier Requested: ${esc(a.premierRequested)}</b>` : ""}<br><span style="color:#c0504d">Tags: ${a.tags.map(esc).join(", ")}</span></td><td>${a.isConfidential ? '<b style="color:#c00">Not for Look Ahead</b><br>' : ""}<b>${esc(a.city)} - ${esc(a.title)}</b><br>${esc(a.details)}</td><td>${a.isIssue ? "<b>Issue</b>" : "FYI Only"}<br>${esc(a.significance)}</td><td>${a.ministry}-${a.id}</td></tr>`,
    )
    .join("");
  return doc(
    size,
    `<h1 style="color:#384c70">GCPE Corporate Calendar: Schedule of Activities</h1><table class="planning"><thead><tr><th>Schedule</th><th>Title &amp; Summary</th><th>Significance</th><th>CC ID#</th></tr></thead><tbody>${rows}</tbody></table>`,
  );
}

/** Running text for renderers that don't read CSS margin boxes (pdfmake, DOCX). */
export const RUNNING = {
  firstHeader: "DRAFT ONLY - NOT FOR CIRCULATION / Information is confidential and subject to change",
  header: "Province of BC — DRAFT AND CONFIDENTIAL",
  footerLeft: UPDATED,
};
