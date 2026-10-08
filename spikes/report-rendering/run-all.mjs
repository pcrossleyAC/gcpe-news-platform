import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lookAheadDays, makeFixture } from "./fixture.mjs";
import { coverHtml, eventsDayHtml, lookAheadHtml, planningHtml } from "./templates.mjs";
import { launch, renderPdf } from "./render-chromium.mjs";
import { renderPdfmake } from "./render-pdfmake.mjs";
import { renderDocx } from "./render-docx.mjs";
import { patchDocx } from "./patch-docx.mjs";
import { measure } from "./measure.mjs";

/** Renders every sample with every approach at both page sizes, writes outputs and a results JSON. */
export async function runAll({ host, outDir, repeat = 5, only = null }) {
  mkdirSync(outDir, { recursive: true });
  const activities = makeFixture();
  const days = lookAheadDays(activities, { days: 60 });
  const busiest = days.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
  const title = "Monday, Nov. 2, 2026 to Thursday, Dec. 31, 2026";
  const samples = {
    cover: (size) => coverHtml(size, title),
    "events-day": (size) => eventsDayHtml(size, busiest),
    planning: (size) => planningHtml(size, activities.slice(0, 40)),
    "look-ahead-60": (size) => lookAheadHtml(size, title, days),
  };
  const results = { host, node: process.version, fixture: { activities: activities.length, lookAheadRows: days.reduce((n, d) => n + d.rows.length, 0) }, runs: [] };

  const t0 = performance.now();
  const browser = await launch(host).catch((e) => ({ error: String(e?.message ?? e) }));
  results.chromiumLaunchMs = Math.round(performance.now() - t0);
  if (browser.error) results.chromiumError = browser.error;
  else results.chromiumVersion = await browser.version();
  const chromiumPid = browser.process?.()?.pid ?? null;

  for (const [name, make] of Object.entries(samples)) {
    if (only && !only.includes(name)) continue;
    for (const size of ["letter", "legal"]) {
      if (name === "planning" && size === "letter") continue; // Planning is Legal landscape only (§10.5)
      if (name !== "planning" && size === "legal" && name !== "events-day") continue; // the Look Ahead is Letter; one Legal Events table proves the size
      const html = make(size);
      const approaches = {
        "pdf-chromium": browser.error ? null : async () => ({ kind: "pdf", bytes: await renderPdf(browser, html) }),
        "pdf-pdfmake": async () => ({ kind: "pdf", bytes: await renderPdfmake(html, size) }),
        "docx-turbodocx": async () => ({ kind: "docx", bytes: await renderDocx(html, size) }),
        "docx-patched": async () => ({ kind: "docx", bytes: await patchDocx(await renderDocx(html, size)) }),
      };
      for (const [approach, fn] of Object.entries(approaches)) {
        if (!fn) continue;
        const runs = [];
        for (let i = 0; i < repeat + 1; i++) {
          let last;
          const r = await measure(`${name}/${size}/${approach}`, async () => (last = await fn()), { chromiumPid }).catch((e) => ({ label: `${name}/${size}/${approach}`, error: String(e?.message ?? e) }));
          runs.push(r);
          if (i === 0 && last) writeFileSync(join(outDir, `${name}.${size}.${approach}.${last.kind}`), last.bytes);
          if (r.error) break;
        }
        const timed = runs.slice(1).filter((r) => !r.error).map((r) => r.ms).sort((a, b) => a - b);
        results.runs.push({ sample: name, size, approach, first: runs[0], medianMs: timed.length ? timed[Math.floor(timed.length / 2)] : null, error: runs.find((r) => r.error)?.error ?? null });
      }
    }
  }
  if (!browser.error) await browser.close();
  writeFileSync(join(outDir, `results.${host}.json`), JSON.stringify(results, null, 2));
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const host = process.argv[2] ?? "local";
  const r = await runAll({ host, outDir: join(process.cwd(), "out", host) });
  console.log(JSON.stringify(r, null, 2));
}
