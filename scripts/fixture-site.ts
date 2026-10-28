/**
 * A fictional site for the Phase 6 exit checks (spec §9): every page type, built by the public
 * site's real builder from in-memory posts, with BC's theme and no database (an in-memory post
 * index). Used by scripts/site-quality.ts (axe and Lighthouse) and tests/fixture-site.test.ts.
 */
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTenantConfig } from "@gcpe/config";
import { loadSiteSettingsDefaults } from "@gcpe/site-settings/node";
import { createSiteBuilder } from "../apps/public-site/src/builder";
import type { CategoryDto, GovernmentTermsDto, PostDto } from "../apps/public-site/src/dto";
import { addDays } from "../apps/public-site/src/government-terms";
import type { NewsApiClient } from "../apps/public-site/src/news-api-client";
import type { IndexedPost, PostIndex } from "../apps/public-site/src/post-index";
import type { SiteInfo } from "../apps/public-site/src/render";
import { ministryMenu } from "../apps/public-site/src/ministry-menu";
import { fsStorage } from "../apps/public-site/src/storage";
import { fakeNewsApi } from "../apps/public-site/test/fake-news-api";
import { post } from "../apps/public-site/test/fixtures";

const BC_TENANT = fileURLToPath(new URL("../config/tenants/bc.json", import.meta.url));

const CATEGORIES: CategoryDto[] = [
  { key: "economy", kind: "sectors", name: "Economy", isActive: true, topPostKey: null, featurePostKey: null },
  { key: "housing", kind: "themes", name: "Housing", isActive: true, topPostKey: null, featurePostKey: null },
  { key: "covid-19", kind: "tags", name: "COVID-19", isActive: true, topPostKey: null, featurePostKey: null },
];

const FIRST_KEY = "2026HLTH0001-000001";

/** One URL per page type (spec §6.1). Sector, theme and tag pages share a template; all three are checked. */
export const FIXTURE_PAGES = [
  "/",
  `/releases/${FIRST_KEY}/`,
  "/ministries/",
  "/ministries/health/",
  "/sectors/economy/",
  "/themes/housing/",
  "/tags/covid-19/",
  "/archive/",
  "/archive/2026/10/",
  "/archive/terms/",
  "/archive/terms/2024-2028/",
  "/search/",
  "/404.html",
];

function memoryIndex(): PostIndex {
  const rows = new Map<string, IndexedPost>();
  const newest = (a: IndexedPost, b: IndexedPost) => b.publishDate.localeCompare(a.publishDate) || (a.key < b.key ? 1 : -1);
  return {
    get: async (k) => rows.get(k) ?? null,
    put: async (p) => void rows.set(p.key, p),
    remove: async (k) => void rows.delete(k),
    inMonth: async (m) => [...rows.values()].filter((p) => p.month === m).sort(newest),
    months: async () => {
      const counts = new Map<string, number>();
      for (const p of rows.values()) counts.set(p.month, (counts.get(p.month) ?? 0) + 1);
      return [...counts].map(([month, count]) => ({ month, count })).sort((a, b) => b.month.localeCompare(a.month));
    },
    keys: async () => [...rows.keys()],
    categories: async () => [...new Set([...rows.values()].flatMap((p) => p.categories))].sort(),
    inCategory: async (token) => [...rows.values()].filter((p) => p.categories.includes(token)).map((p) => p.key).sort(),
    inDayRange: async (start, end) => [...rows.values()].filter((p) => inDays(p, start, end)).sort(newest),
    countInDayRange: async (start, end) => [...rows.values()].filter((p) => inDays(p, start, end)).length,
  };
}

const inDays = (p: IndexedPost, start: string, end: string | null) => {
  const day = p.publishDate.slice(0, 10);
  return day >= start && (end === null || day < end);
};

/** BC's configured terms as NRMS publishes them (newest first; each ends the day before the next starts). */
function termsSnapshot(terms: NonNullable<ReturnType<typeof loadTenantConfig>["governmentTerms"]>): GovernmentTermsDto {
  const newest = [...terms].reverse();
  return {
    publishedAt: "2026-10-28T07:00:00.000Z",
    currentSlug: newest[0]?.slug ?? null,
    terms: newest.map((t, i) => ({ slug: t.slug, label: t.label, startDate: t.startDate, endDate: i === 0 ? null : addDays(newest[i - 1]!.startDate, -1), legacyArchiveUrl: t.legacyArchiveUrl })),
  };
}

/** 24 fictional releases over two months, two ministries, one sector, theme and tag. */
export async function buildFixtureSite(outDir: string, o: { baseUrl: string; test: boolean }): Promise<void> {
  const posts = new Map<string, PostDto>();
  for (let i = 1; i <= 24; i++) {
    const key = `2026HLTH${String(i).padStart(4, "0")}-${String(i).padStart(6, "0")}`;
    const ministry = i % 2 ? "health" : "finance";
    const day = String(((i - 1) % 28) + 1).padStart(2, "0");
    posts.set(
      key,
      post({ key, publishDate: `2026-${i <= 12 ? "10" : "09"}-${day}T10:00:00-07:00`, ministryKeys: [ministry], leadMinistryKey: ministry, sectorKeys: ["economy"], themeKeys: ["housing"], tagKeys: ["covid-19"] }),
    );
  }
  const tenant = loadTenantConfig(BC_TENANT);
  const newsApi: NewsApiClient = {
    ...fakeNewsApi(posts),
    categories: async (kind) => CATEGORIES.filter((c) => c.kind === kind),
    category: async (kind, key) => CATEGORIES.find((c) => c.kind === kind && c.key === key) ?? null,
    governmentTerms: async () => termsSnapshot(tenant.governmentTerms ?? []),
  };
  const site: SiteInfo = { name: tenant.siteName, baseUrl: o.baseUrl, theme: tenant.site.theme, timeZone: tenant.timeZone };
  // BC's tenant settings, as the live site shows them before anything is published: the footer
  // links and the land acknowledgement band, so axe and Lighthouse check them too.
  const settings = loadSiteSettingsDefaults(BC_TENANT, tenant.site.theme);
  const builder = createSiteBuilder({ newsApi, storage: fsStorage(outDir), index: memoryIndex(), site, assetsDir: null });
  const result = await builder.buildAll({ test: o.test, settings, ministryMenu: ministryMenu(await newsApi.ministries()) });
  if (result.failures > 0) throw new Error(`fixture site: ${result.failures} page(s) failed to build`);
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".json": "application/json",
};

/** Gzipped when the client accepts it, as production (boxs.ca's nginx, brotli) compresses text. */
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|rss\+xml)|image\/svg\+xml)/;

/** A static server for the built site: "/x/" serves "x/index.html", a missing file 404.html.
 * Text is gzipped when the client accepts it. */
export async function serveStatic(dir: string): Promise<{ url: string; close(): Promise<void> }> {
  const root = resolve(dir);
  const server = createServer(async (req, res) => {
    let file: string;
    try {
      file = resolve(root, `.${decodeURIComponent(new URL(req.url ?? "/", "http://fixture.invalid").pathname)}`);
      if (relative(root, file).startsWith("..")) throw new Error("outside");
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
      const body = await readFile(file);
      const type = TYPES[extname(file)] ?? "application/octet-stream";
      // Production (boxs.ca's nginx) compresses text; without this, Lighthouse scores an uncompressed site.
      if (COMPRESSIBLE.test(type) && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
        res.writeHead(200, { "content-type": type, "content-encoding": "gzip", vary: "accept-encoding" });
        res.end(gzipSync(body));
      } else {
        res.writeHead(200, { "content-type": type });
        res.end(body);
      }
    } catch {
      res.writeHead(404, { "content-type": TYPES[".html"]! });
      res.end(await readFile(join(root, "404.html")).catch(() => ""));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
