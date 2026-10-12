import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { SiteTheme } from "@gcpe/config";
import { basePath, e, renderPage, type PageOptions, type SiteInfo } from "./render";
import type { SiteStorage } from "./storage";
import { DEFAULT_THEME, themeCss } from "./theme-css";

export function renderNotFoundPage(site: SiteInfo, opts: PageOptions): string {
  const base = basePath(site);
  return renderPage("Page not found", site, `${base}/404.html`, `<h1>Page not found</h1>
<p>The page you asked for isn't here. It may have moved or been removed.</p>
<p><a href="${e(base)}/">Go to the home page</a> or <a href="${e(base)}/archive/">browse the archive</a>.</p>`, opts);
}

/** spec §6.1: test sites keep Disallow: / (constraints.md's test-site rule). */
export function renderRobots(site: SiteInfo, test: boolean): string {
  if (test) return "User-agent: *\nDisallow: /\n";
  return `User-agent: *\nAllow: /\nSitemap: ${new URL(site.baseUrl).origin}${basePath(site)}/sitemap.xml\n`;
}

/** The logo is shown only once its file exists under SITE_ASSETS_DIR (Q76). */
export function logoFor(theme: SiteTheme, assetsDir: string | null, site: Pick<SiteInfo, "baseUrl">): { src: string; alt: string } | null {
  if (!assetsDir || !existsSync(join(assetsDir, theme.logo.path))) return null;
  return { src: `${basePath(site)}/${theme.logo.path}`, alt: theme.logo.alt };
}

/** Every file under `<assetsDir>/assets`, as paths relative to assetsDir; dotfiles skipped. */
async function assetFiles(assetsDir: string): Promise<string[]> {
  const root = join(assetsDir, "assets");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    out.push(relative(assetsDir, join(entry.parentPath, entry.name)).split(sep).join("/"));
  }
  return out.sort();
}

/** theme.css, the tenant's asset files, 404.html and robots.txt — cheap, so written on every build. */
export async function writeStaticPages(storage: SiteStorage, site: SiteInfo, opts: PageOptions, assetsDir: string | null): Promise<void> {
  if (assetsDir) {
    for (const rel of await assetFiles(assetsDir)) await storage.write(rel, new Uint8Array(await readFile(join(assetsDir, rel))));
  }
  await storage.write("assets/theme.css", themeCss(site.theme ?? DEFAULT_THEME));
  await storage.write("404.html", renderNotFoundPage(site, opts));
  await storage.write("robots.txt", renderRobots(site, opts.test === true));
}
