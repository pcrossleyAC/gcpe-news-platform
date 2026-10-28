/**
 * Parity harness: screenshots legacy (news.gov.bc.ca) and our site per page x viewport, diffs the
 * chrome regions, and runs axe on ours only. Local/on-demand; never run in CI.
 *   npm run parity -- --target <base URL> [--legacy <origin>] [--pages a,b] [--regions a,b] [--out dir]
 * Needs Playwright's Chromium (`npx playwright install chromium`). Requests to news.gov.bc.ca are
 * spaced >= 1 s apart (page navigations; the page's own subresources are not throttled).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium, type Browser, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import { AXE_TAGS } from "../../scripts/site-quality";
import { bestRowOffsetMismatch, regionMismatch } from "./diff";
import { PARITY_PAGES, VIEWPORTS } from "./pages";
import { REGIONS, STRICT_MAX, type RegionName } from "./regions";

export type RowStatus = "ok" | "mismatch" | "missing" | "skipped";
export interface Row {
  page: string;
  width: number;
  region: RegionName;
  status: RowStatus;
  ratio: number | null;
  strict: boolean;
  fail: boolean;
}
export interface Load {
  page: string;
  width: number;
  legacyStatus: number | null;
  oursStatus: number | null;
}
export interface AxeFailure {
  page: string;
  width: number;
  id: string;
  impact: string;
  nodes: number;
}

/** Pure row classification, so the pass/fail rules are in one place. */
export function classify(region: RegionName, legacy: boolean, ours: boolean, ratio: number | null): Row["status"] {
  if (region === "banner" && (!legacy || !ours)) return "skipped";
  if (!legacy || !ours) return "missing";
  return ratio !== null && ratio > STRICT_MAX ? "mismatch" : "ok";
}

/** A navigation's final HTTP status as a load error, or null when it is 2xx. */
export function navigationError(status: number | null): string | null {
  if (status === null) return "no response";
  return status >= 200 && status < 300 ? null : `HTTP ${status}`;
}

function parseArgs(argv: string[]) {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const list = (name: string) => get(name)?.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    target: get("target"),
    legacy: get("legacy") ?? "https://news.gov.bc.ca",
    pages: list("pages"),
    regions: list("regions"),
    out: get("out") ?? join("parity-out", new Date().toISOString().replace(/[:.]/g, "-")),
  };
}

let lastLegacyHit = 0;
async function throttle(url: string): Promise<void> {
  if (new URL(url).host !== "news.gov.bc.ca") return;
  const wait = lastLegacyHit + 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastLegacyHit = Date.now();
}

/** Navigates and returns the final HTTP status (null when Playwright reports no response). */
async function load(page: Page, url: string): Promise<number | null> {
  await throttle(url);
  const response = await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  return response?.status() ?? null;
}

async function shot(page: Page, selector: string): Promise<Buffer | null> {
  const loc = page.locator(selector).first();
  if ((await loc.count()) === 0) return null;
  try {
    return await loc.screenshot({ timeout: 10_000 });
  } catch {
    return null; // present but not renderable (e.g. display:none) counts as missing
  }
}

const join1 = (base: string, path: string) => base.replace(/\/+$/, "") + path;

export async function runParity(argv: string[], log: (l: string) => void = console.log): Promise<number> {
  const args = parseArgs(argv);
  if (!args.target) {
    log("parity: --target <base URL> is required");
    return 1;
  }
  const pages = PARITY_PAGES.filter((p) => !args.pages || args.pages.includes(p.name));
  const unknownPages = (args.pages ?? []).filter((n) => !PARITY_PAGES.some((p) => p.name === n));
  const regionNames = (Object.keys(REGIONS) as RegionName[]).filter((r) => !args.regions || args.regions.includes(r));
  const unknownRegions = (args.regions ?? []).filter((r) => !(r in REGIONS));
  if (unknownPages.length || unknownRegions.length || pages.length === 0) {
    log(`parity: unknown page(s) [${unknownPages}] or region(s) [${unknownRegions}], or nothing selected`);
    return 1;
  }

  await mkdir(args.out, { recursive: true });
  const rows: Row[] = [];
  const axeFailures: AxeFailure[] = [];
  const loadErrors: string[] = [];
  const loads: Load[] = [];
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    for (const pg of pages) {
      for (const vp of VIEWPORTS) {
        const ctx = await browser.newContext({ viewport: vp });
        const legacyPage = await ctx.newPage();
        const oursPage = await ctx.newPage();
        const tag = `${pg.name}-${vp.width}`;
        const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
        try {
          const legacyUrl = join1(args.legacy, pg.path);
          const oursUrl = join1(args.target, pg.oursPath ?? pg.path);
          const legacyStatus = await load(legacyPage, legacyUrl);
          const oursStatus = await load(oursPage, oursUrl);
          loads.push({ page: pg.name, width: vp.width, legacyStatus, oursStatus });
          // A 404/500 page that carries the same chrome would otherwise pass the strict diffs.
          const bad = [
            [legacyUrl, navigationError(legacyStatus)],
            [oursUrl, navigationError(oursStatus)],
          ].filter(([, err]) => err !== null);
          if (bad.length > 0) {
            for (const [url, err] of bad) loadErrors.push(`${tag}: ${err} for ${url}`);
            await ctx.close();
            continue;
          }
        } catch (e) {
          loadErrors.push(`${tag}: ${msg(e)}`);
          await ctx.close();
          continue;
        }
        // Any throw below (screenshot, axe, a write) is recorded for this page/viewport and the run
        // moves on, so report.json is always written with the rows gathered so far.
        try {
          for (const name of regionNames) {
            const { selector, strict } = REGIONS[name];
            const [l, o] = [await shot(legacyPage, selector), await shot(oursPage, selector)];
            if (l) await writeFile(join(args.out, `${tag}-${name}-legacy.png`), l);
            if (o) await writeFile(join(args.out, `${tag}-${name}-ours.png`), o);
            let ratio: number | null = null;
            if (l && o) {
              // Strict regions forgive a one-row sub-pixel crop offset (bestRowOffsetMismatch).
              const [lp, op] = [PNG.sync.read(l), PNG.sync.read(o)];
              const r = strict ? bestRowOffsetMismatch(lp, op) : regionMismatch(lp, op);
              ratio = r.ratio;
              await writeFile(join(args.out, `${tag}-${name}-diff.png`), PNG.sync.write(r.diff));
            }
            const status = classify(name, !!l, !!o, ratio);
            // Non-strict regions report a ratio but never fail; strict ones fail on missing/mismatch.
            const fail = strict && (status === "missing" || status === "mismatch");
            rows.push({ page: pg.name, width: vp.width, region: name, status, ratio, strict, fail });
          }
          // Full-page shots, named per the harness contract.
          await legacyPage.screenshot({ path: join(args.out, `${tag}-legacy.png`), fullPage: true });
          await oursPage.screenshot({ path: join(args.out, `${tag}-ours.png`), fullPage: true });
          const { violations } = await new AxeBuilder({ page: oursPage }).withTags(AXE_TAGS).analyze();
          for (const v of violations) {
            if (v.impact === "serious" || v.impact === "critical") {
              axeFailures.push({ page: pg.name, width: vp.width, id: v.id, impact: v.impact, nodes: v.nodes.length });
            }
          }
        } catch (e) {
          loadErrors.push(`${tag}: capture failed: ${msg(e)}`);
        } finally {
          await ctx.close().catch(() => undefined);
        }
      }
    }
  } catch (e) {
    loadErrors.push(`run: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await browser?.close();
  }

  for (const r of rows) {
    log(
      `${r.fail ? "FAIL" : "ok  "} ${r.page.padEnd(10)} ${String(r.width).padStart(4)} ${r.region.padEnd(7)} ${r.status.padEnd(8)}` +
        (r.ratio === null ? "" : ` ${r.ratio.toFixed(4)}`) +
        (r.strict ? "" : " (not strict)"),
    );
  }
  for (const a of axeFailures) log(`FAIL axe ${a.page} ${a.width} ${a.impact} ${a.id} (${a.nodes} nodes)`);
  for (const e of loadErrors) log(`FAIL load ${e}`);

  const failed = rows.some((r) => r.fail) || axeFailures.length > 0 || loadErrors.length > 0;
  await writeFile(
    join(args.out, "report.json"),
    JSON.stringify({ target: args.target, legacy: args.legacy, strictMax: STRICT_MAX, loads, rows, axeFailures, loadErrors, failed }, null, 2),
  );
  log(`parity: ${failed ? "FAILED" : "passed"}; report at ${join(args.out, "report.json")}`);
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runParity(process.argv.slice(2)).then(
    (code) => void (process.exitCode = code),
    (e: unknown) => {
      console.error("parity: failed to run", e);
      process.exitCode = 1;
    },
  );
}
