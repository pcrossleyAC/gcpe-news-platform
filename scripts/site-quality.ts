/**
 * Phase 6 exit (spec §9): axe-core and Lighthouse on every public page type of a fictional,
 * production-config fixture site (scripts/fixture-site.ts). Exits 1 on any axe violation or any
 * score below its threshold. Needs Playwright's Chromium (`npx playwright install chromium`).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import * as chromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";
import { buildFixtureSite, FIXTURE_PAGES, serveStatic } from "./fixture-site";

export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
/**
 * Spec §9: SEO counts here because this is a production-config build (indexable).
 *
 * Performance is 80, not 90, since parity plan 1 Task 4 (C212): every page now loads news.gov's
 * own CSS (Bootstrap 5 plus the legacy site CSS, about 345 KB raw), vendored unmodified (P3).
 * After gzip in the fixture server, one bundled stylesheet, print.css off the critical path and
 * a preloaded BC Sans with font-display: swap, the score measured 85–87 on every page over
 * three runs at Task 4 and 84–86 at the end of plan 1 (three runs, 2026-10-28; it was 100 with our
 * own 1 KB theme.css). The gate sits at 80, about 4 points below the lowest measurement, so CI
 * runner noise doesn't fail a build that measures 84 locally; a page that drops below 84 locally
 * is a regression to look at, not noise. The rest is the CSS weight itself; PurgeCSS
 * is planned once the look is approved (look-and-feel chunk 10), and the threshold goes back to
 * 90 then.
 */
export const THRESHOLDS: Record<string, number> = { performance: 80, accessibility: 95, "best-practices": 90, seo: 90 };

export async function runSiteQuality(log: (line: string) => void = console.log): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "gcpe-site-quality-"));
  const failures: string[] = [];
  let server: { url: string; close(): Promise<void> } | undefined;
  try {
    server = await serveStatic(dir);
    await buildFixtureSite(dir, { baseUrl: server.url, test: false });
    log(`Fixture site (production config, fictional content) at ${server.url}`);

    const browser = await chromium.launch();
    try {
      const page = await (await browser.newContext()).newPage();
      for (const path of FIXTURE_PAGES) {
        const res = await page.goto(server.url + path);
        if (res?.status() !== 200) failures.push(`${path}: HTTP ${res?.status()}`);
        const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
        log(`axe ${path}: ${violations.length === 0 ? "0 violations" : violations.map((v) => `${v.id} (${v.impact}, ${v.nodes.length} node(s))`).join(", ")}`);
        if (violations.length > 0) failures.push(`${path}: ${violations.length} axe violation(s)`);
      }
    } finally {
      await browser.close();
    }

    const chrome = await chromeLauncher.launch({ chromePath: chromium.executablePath(), chromeFlags: ["--headless=new", "--no-sandbox"] });
    try {
      for (const path of FIXTURE_PAGES) {
        const result = await lighthouse(server.url + path, { port: chrome.port, output: "json", logLevel: "error", onlyCategories: Object.keys(THRESHOLDS) });
        if (!result) {
          failures.push(`${path}: Lighthouse returned no result`);
          continue;
        }
        const scores = Object.fromEntries(Object.keys(THRESHOLDS).map((id) => [id, Math.round((result.lhr.categories[id]?.score ?? 0) * 100)]));
        log(`lighthouse ${path}: ${Object.entries(scores).map(([id, s]) => `${id} ${s}`).join(", ")}`);
        for (const [id, min] of Object.entries(THRESHOLDS)) if ((scores[id] ?? 0) < min) failures.push(`${path}: ${id} ${scores[id]} < ${min}`);
      }
    } finally {
      chrome.kill();
    }
  } finally {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
  return failures;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runSiteQuality().then(
    (failures) => {
      if (failures.length === 0) return void console.log("site quality: every page passed axe and Lighthouse");
      console.error(`site quality: ${failures.length} failure(s)\n${failures.map((f) => `- ${f}`).join("\n")}`);
      process.exitCode = 1;
    },
    (e: unknown) => {
      console.error("site quality: failed to run", e);
      process.exitCode = 1;
    },
  );
}
