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

/** The fixture release with French (FIXTURE_PAGES[1]). */
const RELEASE = FIXTURE_PAGES[1]!;

/** How many level-1 headings the page exposes (an h1 or role=heading aria-level=1 that renders). */
const exposedLevelOne = (page: import("@playwright/test").Page) =>
  page.evaluate(() => [...document.querySelectorAll('h1, [role="heading"][aria-level="1"]')].filter((el) => el.getClientRects().length > 0).length);

/**
 * The release page's other states, which the per-page pass (English, with script) never reaches:
 * - French on (the toggle pressed): axe clean, exactly one exposed level-1 heading, `<html lang="en">` kept (P2-R3);
 * - no script (site.js fails to load, so its onerror drops html.js — what JavaScript off looks like
 *   to the CSS): axe clean, both languages shown, no language selector or Print button (they can't
 *   work), exactly one exposed level-1 heading.
 */
export async function checkReleaseStates(browser: import("@playwright/test").Browser, url: string, log: (line: string) => void): Promise<string[]> {
  const failures: string[] = [];
  const fail = (what: string) => failures.push(`${RELEASE} ${what}`);
  const french = await (await browser.newContext()).newPage();
  await french.goto(url + RELEASE);
  await french.locator('button[data-story-lang="secondary"]').click();
  const frAxe = (await new AxeBuilder({ page: french }).withTags(AXE_TAGS).analyze()).violations;
  const frHeadings = await exposedLevelOne(french);
  const frLang = await french.evaluate(() => document.documentElement.lang);
  log(`axe ${RELEASE} (French): ${frAxe.length} violation(s); level-1 headings ${frHeadings}; html lang ${frLang}`);
  if (frAxe.length > 0) fail(`(French): ${frAxe.map((v) => v.id).join(", ")}`);
  if (frHeadings !== 1) fail(`(French): ${frHeadings} level-1 headings exposed, expected 1`);
  if (frLang !== "en") fail(`(French): html lang "${frLang}", expected "en"`);

  const context = await browser.newContext();
  await context.route(/\/assets\/site\/site\.js$/, (r) => r.abort());
  const noJs = await context.newPage();
  await noJs.goto(url + RELEASE);
  const noJsAxe = (await new AxeBuilder({ page: noJs }).withTags(AXE_TAGS).analyze()).violations;
  const shown = (sel: string) => noJs.locator(sel).evaluateAll((els) => els.filter((el) => el.getClientRects().length > 0).length);
  const [selectors, print, frenchCopy, headings] = [await shown(".language-selector"), await shown(".print-document"), await shown(".story-copy.story-lang.secondary"), await exposedLevelOne(noJs)];
  log(`axe ${RELEASE} (no script): ${noJsAxe.length} violation(s); selectors shown ${selectors}; Print shown ${print}; French copy shown ${frenchCopy}; level-1 headings ${headings}`);
  if (noJsAxe.length > 0) fail(`(no script): ${noJsAxe.map((v) => v.id).join(", ")}`);
  if (selectors !== 0 || print !== 0) fail(`(no script): ${selectors} language selector(s) and ${print} Print button(s) shown, expected none`);
  if (frenchCopy !== 1) fail(`(no script): the French copy is not shown`);
  if (headings !== 1) fail(`(no script): ${headings} level-1 headings exposed, expected 1`);
  await context.close();

  // Share and Translations are in the DOM twice (the side column `.story-features` and the phone
  // `.story-info`), and the side column also carries the ministry link groups; the vendored legacy
  // CSS (assets/legacy/Content) hides one copy per width. Nothing else hides them, so this is the
  // test that catches a CSS change (chunk 10's PurgeCSS) that would show both. The hidden copy
  // must be display:none (no boxes), not merely off screen, so assistive technology reads one.
  // The PostCard's Translations link targets the body's #translations, which shows at both widths.
  for (const width of [390, 1280]) {
    const sized = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await sized.newPage();
    await page.goto(url + RELEASE);
    const rendered = (sel: string) => page.locator(sel).evaluateAll((els) => els.filter((el) => el.getClientRects().length > 0).length);
    const counts = Object.fromEntries(
      await Promise.all(([["Share", ".resource-links.share"], ["Translations", ".story-features .resource-links.translate, .story-info .resource-links.translate"], ["side column or phone row", ".story-features, .story-info"], ["#translations", "#translations"]] as const).map(async ([name, sel]) => [name, await rendered(sel)] as const)),
    );
    log(`${RELEASE} at ${width}px: rendered ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")}`);
    for (const [name, n] of Object.entries(counts)) if (n !== 1) fail(`at ${width}px: ${n} ${name} copies rendered, expected exactly 1 (the other display:none)`);
    await sized.close();
  }
  return failures;
}

/**
 * Home, ministry and bio pages: the news column comes first in the DOM, so on a phone (390px),
 * where the side column stacks below it, reading and focus order match what is seen; on a desktop
 * (1280px) CSS order puts the side column on the left, as legacy shows it.
 */
export async function checkLayoutOrder(browser: import("@playwright/test").Browser, url: string, log: (line: string) => void): Promise<string[]> {
  const failures: string[] = [];
  for (const path of ["/", "/ministries/health/", "/ministries/health/biography/"]) {
    for (const width of [390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      await page.goto(url + path);
      const body = await page.locator(".home-layout > .home-body").boundingBox();
      const side = await page.locator(".home-layout > .home-features").boundingBox();
      const domBodyFirst = await page.locator(".home-layout").evaluate((el) => el.firstElementChild?.classList.contains("home-body") === true);
      await context.close();
      if (!body || !side) {
        failures.push(`${path} at ${width}px: the news or side column is not rendered`);
        continue;
      }
      const visual = width < 768 ? (body.y < side.y ? "news above column" : "column above news") : side.x < body.x ? "column left of news" : "column right of news";
      log(`${path} at ${width}px: DOM ${domBodyFirst ? "news first" : "column first"}; ${visual}`);
      if (!domBodyFirst) failures.push(`${path} at ${width}px: the side column precedes the news in the DOM`);
      if (width < 768 && visual !== "news above column") failures.push(`${path} at ${width}px: ${visual}, so reading order differs from what is seen`);
      if (width >= 768 && visual !== "column left of news") failures.push(`${path} at ${width}px: ${visual}, expected the legacy left column`);
    }
  }
  return failures;
}

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
      failures.push(...(await checkReleaseStates(browser, server.url, log)));
      failures.push(...(await checkLayoutOrder(browser, server.url, log)));
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
