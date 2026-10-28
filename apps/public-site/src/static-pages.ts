import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { basePath, e, renderPage, type PageOptions, type SiteInfo } from "./render";
import { bannerJson, themeDefaults } from "./settings";
import { writeBuiltinAssets } from "./site-assets";
import type { SiteStorage } from "./storage";
import { GOOGLE_VERIFICATION_FILE_RE } from "./verification";
import { DEFAULT_THEME, themeCss } from "./theme-css";

export function renderNotFoundPage(site: SiteInfo, opts: PageOptions): string {
  const base = basePath(site);
  const { heading, text } = (opts.settings ?? themeDefaults(site.theme)).pageText.notFound;
  // An empty heading would leave the page's one h1 blank: both it and the title fall back.
  const title = heading.trim() || "Page not found";
  return renderPage(title, site, `${base}/404.html`, `<div class="home-body not-found">
<h1>${e(title)}</h1>${text.trim() !== "" ? `\n<p>${e(text)}</p>` : ""}
<form class="search-panel-bar" role="search" aria-label="Search for the page" action="${e(base)}/search/" method="get" data-prefill-from-path>
<label for="not-found-q">Search for the page</label>
<input id="not-found-q" name="q" type="search">
<button type="submit">Search</button>
</form>
<p><a href="${e(base)}/">Go to the home page</a> or <a href="${e(base)}/archive/">browse the archive</a>.</p>
</div>`, opts);
}

const LEGACY_DISALLOWS = ["/error", "/files", "/search", "/Search", "/SEARCH", "/subscribe"];

/** spec §6.1: test sites keep Disallow: / (constraints.md's test-site rule). */
export function renderRobots(site: SiteInfo, test: boolean): string {
  if (test) return "User-agent: *\nDisallow: /\n";
  // Legacy robots.txt's Disallows, less /assets (our CSS and JS live there; crawlers must render pages).
  return `User-agent: *\n${LEGACY_DISALLOWS.map((p) => `Disallow: ${p}\n`).join("")}Sitemap: ${new URL(site.baseUrl).origin}${basePath(site)}/sitemap.xml\n`;
}

/** Every file under `<assetsDir>/assets`, as paths relative to assetsDir; any path segment
 * starting with a dot is skipped — a dotfile itself (e.g. `.hidden`) and any file inside a
 * hidden directory (e.g. `.git/config`), since `entry.name` is only the file's own basename. */
async function assetFiles(assetsDir: string): Promise<string[]> {
  const root = join(assetsDir, "assets");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const rel = relative(assetsDir, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (rel.split("/").some((seg) => seg.startsWith("."))) continue;
    out.push(rel);
  }
  return out.sort();
}

/** theme.css (the settings' colours), site-banner.json (the settings' banner, read by every
 * page's inline script), the tenant's asset files, 404.html and robots.txt — cheap, so written on
 * every build, and the only page a theme or banner change rebuilds. */
export async function writeStaticPages(storage: SiteStorage, site: SiteInfo, opts: PageOptions, assetsDir: string | null): Promise<void> {
  await writeBuiltinAssets(storage);
  if (assetsDir) {
    for (const rel of await assetFiles(assetsDir)) await storage.write(rel, new Uint8Array(await readFile(join(assetsDir, rel))));
  }
  const theme = site.theme ?? DEFAULT_THEME;
  const settings = opts.settings ?? themeDefaults(theme);
  await storage.write("assets/theme.css", themeCss(theme, settings.theme.colors));
  await storage.write("assets/site-banner.json", bannerJson(settings));
  await storage.write("404.html", renderNotFoundPage(site, opts));
  await storage.write("robots.txt", renderRobots(site, opts.test === true));
  const gsc = site.verification?.googleFile;
  if (gsc && GOOGLE_VERIFICATION_FILE_RE.test(gsc)) await storage.write(gsc, `google-site-verification: ${gsc}\n`);
}
