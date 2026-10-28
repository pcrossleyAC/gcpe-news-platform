/**
 * A fictional site for the Phase 6 exit checks (spec §9): every page type, built by the public
 * site's real builder from in-memory posts, with BC's theme and no database (an in-memory post
 * index). Used by scripts/site-quality.ts (axe and Lighthouse) and tests/fixture-site.test.ts.
 */
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTenantConfig } from "@gcpe/config";
import { loadSiteSettingsDefaults } from "@gcpe/site-settings/node";
import { createSiteBuilder } from "../apps/public-site/src/builder";
import type { CategoryDto, GovernmentTermsDto, PostDto, SlideDto } from "../apps/public-site/src/dto";
import { addDays } from "../apps/public-site/src/government-terms";
import type { NewsApiClient } from "../apps/public-site/src/news-api-client";
import type { IndexedPost, PostIndex } from "../apps/public-site/src/post-index";
import type { SiteInfo } from "../apps/public-site/src/render";
import { ministryMenu } from "../apps/public-site/src/ministry-menu";
import { fsStorage } from "../apps/public-site/src/storage";
import { fakeNewsApi } from "../apps/public-site/test/fake-news-api";
import { contact, link, ministry, post, slide } from "../apps/public-site/test/fixtures";

const BC_TENANT = fileURLToPath(new URL("../config/tenants/bc.json", import.meta.url));
const SLIDE_IMAGE = fileURLToPath(new URL("./fixture-assets/slide.jpg", import.meta.url));

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
  "/ministries/health/biography/",
  "/ministries/office-of-the-premier/",
  "/sectors/economy/",
  "/themes/housing/",
  "/tags/covid-19/",
  "/archive/",
  "/archive/2026/10/",
  "/archive/terms/",
  "/archive/terms/2024-2028/",
  "/search/",
  "/contacts/",
  "/privacy/",
  "/404.html",
];

function memoryIndex(): PostIndex {
  const rows = new Map<string, IndexedPost>();
  let termsHash: string | null = null;
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
    withLeadMinistry: async (key) => [...rows.values()].filter((p) => p.leadMinistry === key.toLowerCase()).map((p) => p.key).sort(),
    inDayRange: async (start, end) => [...rows.values()].filter((p) => inDays(p, start, end)).sort(newest),
    countInDayRange: async (start, end) => [...rows.values()].filter((p) => inDays(p, start, end)).length,
    appliedTermsHash: async () => termsHash,
    setAppliedTermsHash: async (h) => void (termsHash = h),
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
      post({
        key,
        publishDate: `2026-${i <= 12 ? "10" : "09"}-${day}T10:00:00-07:00`,
        ministryKeys: [ministry],
        leadMinistryKey: ministry,
        sectorKeys: ["economy"],
        themeKeys: ["housing"],
        tagKeys: ["covid-19"],
        hasTranslations: i % 3 === 0,
        hasMediaAssets: i % 4 === 0,
        // No Flickr assetUrl: its thumbnail would make site:quality fetch live.staticflickr.com, so
        // the gate would depend on a third party. post-card.test.ts pins the thumbnail markup.
      }),
    );
  }
  // The first release carries everything the release page can show (its fixture-page check):
  // two backgrounders, a French document, two translations, two media assets and a byline.
  const first = posts.get(FIRST_KEY)!;
  posts.set(FIRST_KEY, {
    ...first,
    hasMediaAssets: true,
    hasTranslations: true,
    // A YouTube lead: the page shows a link with the vendored placeholder (no third-party load),
    // and only og:image names YouTube's thumbnail.
    assetUrl: "https://www.youtube.com/watch?v=abc123DEF45",
    documents: [
      {
        languageId: 4105,
        pageTitle: "News Release",
        headline: "Clinics to open across the province",
        subheadline: "Twelve new clinics open this month",
        byline: "Ministry of Health\nJoint statement",
        detailsHtml: "<p>Twelve clinics will open across the province this month, the Ministry of Health announced today.</p><p>Each clinic is open seven days a week.</p>",
        contacts: [{ title: "Ministry of Health", details: "Media Relations\n250 555-0100" }],
      },
      {
        languageId: 3084,
        pageTitle: "Communiqué",
        headline: "Ouverture de cliniques dans la province",
        subheadline: "Douze nouvelles cliniques ouvrent ce mois-ci",
        byline: null,
        detailsHtml: "<p>Douze cliniques ouvriront dans la province ce mois-ci.</p>",
        contacts: [],
      },
      { languageId: 4105, pageTitle: "Backgrounder", headline: "Where the clinics are", subheadline: null, detailsHtml: "<ul><li>Victoria</li><li>Kelowna</li></ul>", contacts: [] },
      {
        languageId: 4105,
        pageTitle: "Backgrounder",
        headline: "How to book",
        subheadline: "Booking opens Monday",
        detailsHtml: "<p>Book online or by phone.</p>",
        contacts: [{ title: "Booking line", details: "1 800 555-0100" }],
      },
    ],
    azureAssets: [
      { key: `${o.baseUrl}/fixture/clinic-photo.jpg`, label: "Clinic photo", length: 524288 },
      { key: `${o.baseUrl}/fixture/fact-sheet.pdf`, label: "Fact sheet", length: 1229 },
    ],
    azureTranslations: [
      { key: `${o.baseUrl}/fixture/translation-zh.pdf`, label: "Chinese(Simplified)", length: 2048 },
      { key: `${o.baseUrl}/fixture/translation-pa.pdf`, label: "Punjabi", length: 2048 },
    ],
  });
  // Home's carousel band: two slides with images and the second right-justified. The image is a
  // local file (no network in CI): scripts/fixture-assets/slide.jpg, legacy's default-og-image-new.jpg
  // (Apache-2.0) resized to 1280px at JPEG quality 45, 64 KB — the weight an optimised slide should have.
  await mkdir(join(outDir, "fixture"), { recursive: true });
  await copyFile(SLIDE_IMAGE, join(outDir, "fixture", "slide.jpg"));
  const image = `${o.baseUrl}/fixture/slide.jpg`;
  const slides: SlideDto[] = [
    slide({ key: "slide-1", headline: "Clinics opening across the province", actionUri: `${o.baseUrl}/releases/${FIRST_KEY}/`, actionLabel: "Read the release", imageUrl: image, sortIndex: 0 }),
    slide({ key: "slide-2", headline: "Have your say on housing", summary: "Share your views before the end of the month.", actionUri: `${o.baseUrl}/themes/housing/`, actionLabel: null, imageUrl: image, sortIndex: 1, justify: "right" }),
  ];
  const tenant = loadTenantConfig(BC_TENANT);
  const newsApi: NewsApiClient = {
    ...fakeNewsApi(posts),
    // A top and a feature post, as news.gov's home always has.
    home: async () => ({ granville: null, topPostKey: "2026HLTH0010-000010", featurePostKey: "2026HLTH0009-000009" }),
    slides: async () => slides,
    // Health has Flickr and YouTube links, so the release's related band shows Connect with the Ministry.
    ministry: async (key) => (await newsApi.ministries()).find((m) => m.key === key.toLowerCase()) ?? null,
    ministries: async () => [
      ministry({
        key: "health",
        name: "Health",
        // Shown in brackets and italics under the name on /contacts/ (legacy <i>), so the page is
        // scored with the italic face it really loads (P4-R6).
        displayAdditionalName: "Health Services",
        flickrUri: "https://www.flickr.com/photos/bcgovphotos/",
        youtubeUri: "https://www.youtube.com/user/ProvinceofBC",
        topicLinks: [link({ uri: "https://www2.gov.bc.ca/gov/content/health", key: "Health care in B.C." })],
        serviceLinks: [link({ uri: "https://www2.gov.bc.ca/gov/content/health/health-drug-coverage", key: "Health coverage" })],
        contactUser: contact({ fullName: "Sam Example", phoneNumber: "250-555-0100", mobileNumber: "250-555-0101", emailAddress: "Sam.Example@gov.bc.ca" }),
        secondContactUser: contact({ fullName: "Jordan Example", phoneNumber: "250-555-0102", emailAddress: "Jordan.Example@gov.bc.ca" }),
        weekendContactNumber: "250-555-0199",
      }),
      ministry({ key: "finance", name: "Finance" }),
      // The Premier: "More from the Premier", Meet the Team (team links) and a top story.
      ministry({ key: "office-of-the-premier", name: "Office of the Premier", ministryUrl: "https://www2.gov.bc.ca/gov/content/governments/organizational-structure/office-of-the-premier", topPostKey: "2026HLTH0010-000010" }),
      // A child of Health with its own media contact: /contacts/ lists it indented under Health.
      ministry({
        key: "trade",
        name: "Minister of State for Trade",
        ministryUrl: null,
        parentMinistryKey: "health",
        contactUser: contact({ fullName: "Trade Media Desk", mobileNumber: "250-555-0103", emailAddress: "Trade.Media@gov.bc.ca" }),
      }),
    ],
    // Health's minister has a photo and a bio, so the biography page (H2) is built; the photo is the
    // local slide image (no network in CI).
    minister: async (key) =>
      key.toLowerCase() === "office-of-the-premier"
        ? { headline: "Hon. Casey Example", summary: "Premier of British Columbia.", details: null, photo: image }
        : key.toLowerCase() === "trade"
        ? { headline: "Hon. Robin Example", summary: "Minister of State for Trade.", details: "<p>Robin Example was elected in 2024.</p>", photo: image }
        : key.toLowerCase() === "health"
        ? {
            headline: "Hon. Alex Example",
            summary: "Minister of Health.\nMLA for Victoria-Example.",
            // Core's bio allow-list (BIO_TAGS): paragraphs, strong, lists and links, no headings.
            details: "<p>Alex Example was elected MLA for Victoria-Example in 2020.</p><p>Before politics, Alex worked as a <strong>family physician</strong> for fifteen years.</p><ul><li>Minister of Health, 2024</li></ul>",
            photo: image,
          }
        : null,
    // Health has a minister of state (legacy MinisterOfState); the Premier has Meet the Team links.
    ministryProfiles: async () => [
      { key: "health", ministerEmail: "HLTH.Minister@gov.bc.ca", teamLinks: [], childKeys: ["trade"] },
      {
        key: "office-of-the-premier",
        ministerEmail: null,
        teamLinks: [
          { text: "Cabinet Ministers", url: "https://www2.gov.bc.ca/gov/content/governments/organizational-structure/cabinet/cabinet-ministers" },
          { text: "Deputy Ministers", url: "https://www2.gov.bc.ca/gov/content/governments/organizational-structure/ministries-organizations/deputy-ministers" },
          { text: "Cabinet Committees", url: "https://www2.gov.bc.ca/gov/content/governments/organizational-structure/cabinet/cabinet-committees" },
        ],
        childKeys: [],
      },
    ],
    resourceLinks: async () => [link({ uri: "/contacts/", key: "Media Contacts" }), link({ uri: "https://www2.gov.bc.ca/", key: "BC Government" }), link({ uri: `${o.baseUrl}/archive/`, key: "News Archive" })],
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
  ".jpg": "image/jpeg",
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
