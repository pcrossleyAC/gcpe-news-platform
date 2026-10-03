# Phase 1 — News API v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node/Postgres News API that is a drop-in replacement for the 26 non-newsletter endpoints of `api.news.gov.bc.ca` (plus its SignalR `/updates` hub), fed by Core and NRMS events, verified against recorded live responses, and loadable from legacy SQL Server.

**Architecture:** `apps/news-api` owns a denormalized, response-shaped store of published content. It receives signed events (`org.*`, `sector|theme|tag.*`, `release.*`, `site.content.changed`) through `@gcpe/events`'s receiver and projects them into tables. Read endpoints serialize rows into the legacy JSON shapes. Projections send Postgres `NOTIFY` messages inside the same transaction. Every replica `LISTEN`s and pushes SignalR invocations to connected clients, as `gcpe-news-webapp` expects. Subscribe endpoints proxy to NoD.

**Tech Stack:** Phase 0 stack plus `ws` 8 (SignalR server transport), `@microsoft/signalr` 10 (test client), `express-rate-limit` 8.

**Spec:** `docs/superpowers/specs/2026-10-02-gcpe-news-platform-design.md` (§6, especially §6.1 "Observed live behaviour that is part of the contract")

**Depends on:** Phase 0 plan (`2026-10-02-phase-0-foundation.md`) fully implemented.

## Global Constraints

Everything in the Phase 0 Global Constraints, plus:
- Reproduce the 26 non-newsletter swagger endpoints with identical paths, parameters and JSON shapes; `/api/Newsletters*` is out of scope (spec §6.1).
- `api-version` is required: missing → `400 {"error":{"code":"ApiVersionUnspecified","message":"An API version is required, but was not specified.","innerError":null}}`; anything except `1.0`/`1` → `400` with code `UnsupportedApiVersion`.
- Lookups of keys, index keys and references are case-insensitive; responses keep stored casing.
- `Posts/{key}`, `Ministries/{key}`, `Ministries/{key}/Minister`, `Sectors|Themes|Tags/{key}`, `Slides/{id}`, `Posts/Keys/{reference}` → `200` with an **empty body** when not found. Index endpoints: known kind + unknown key → `404` problem JSON; unknown kind → `200` empty. `LatestMediaUri` with no match → `204`.
- `postKind` omitted or `default` → `releases` + `stories`. `count` omitted → all. Order: `publishDate` desc. `Latest` excludes the index's top and feature posts; `Keys` does not. `postKeys` is comma-separated: request order, unknown keys skipped, only the first repeated parameter is used.
- `memoryCachable` never appears in responses. `newsletterLinks` is always `[]`.
- Timestamps are serialized in the tenant time zone with offset (BC: `America/Vancouver`); the fractional part is omitted when milliseconds are zero.
- SignalR hub at `/updates` (JSON protocol v1, WebSockets transport) with targets `PostUpdate`, `MinisterUpdate`, `HomeUpdate`, `SlideUpdate`, `ResourceLinkUpdate`, `ThemeUpdate`, `TagUpdate`, `SectorUpdate`, `MinistryUpdate` (one argument: array of keys); ping every 15 s.
- The News API stores no subscriber data; `/api/Subscribe/*` is proxied to NoD (spec §6.1).

## Review Focus

1. **Real legacy data differing from the live API's derived values.** These five mappings are inferred, not verified: ministry `name` (from `Ministry.DisplayName`), minister `emailHtml` format, document contact split (`Information` → `title` + `details`), `redirectUri` (`""` → `null`), and slide `justify` (int → text). Task 11 pins each one with a mapper test. **A rehearsal comparison is still needed:** import a legacy DB copy, then diff `/api/Ministries` and `/api/Posts/Latest/home/default?count=20` against the live API. This is listed in the exit check.
2. **The webapp reconnecting to `/updates` after a News API restart.** The hub must accept a fresh negotiate and connection without state from the old process. Task 9 covers this: `client reconnects after hub restart`.
3. **`count` omitted on Latest** returns every post (28k+ on live). This matches live behaviour but is heavy. Task 7 covers it: `Latest without count returns all posts, ordered`. The query selects only the needed columns for `Keys`.
4. **Mixed-case keys in index paths and `postKeys`.** Task 7 covers it: `Keys/ministries/HEALTH` and `postKeys` with lowercase keys.
5. **Unpublished posts.** A post must vanish from every endpoint, including `Keys/{reference}` and `postKeys`. Task 7 covers it: `unpublished post is invisible everywhere`.

---

## File Structure

```
packages/events/src/catalogue.ts              # + release.*, site.content.changed schemas
apps/news-api/
  package.json, drizzle.config.ts, Dockerfile
  migrations/                                  # generated
  scripts/record-live-fixtures.ts              # records live responses → test/fixtures/live/*.json
  scripts/seed-from-fixtures.ts                # dev: load fixture world into a local DB
  src/
    db/schema.ts                               # posts, categories, category_features, home, slides, resource_links (+ event tables)
    time.ts                                    # formatOffsetDateTime / parseOffsetDateTime
    updates/notify.ts                          # pg_notify + LISTEN helper, UpdateTarget type
    updates/hub.ts                             # minimal SignalR server (negotiate + WebSocket JSON protocol)
    projections.ts                             # event handlers → tables (+ notify)
    dto.ts                                     # rows → legacy JSON shapes
    read.ts                                    # read queries used by routes
    http/errors.ts                             # api-version middleware, empty 200, problem 404
    http/v1/categories.ts                      # Ministries, Sectors, Themes, Tags
    http/v1/site.ts                            # Home, Slides, ResourceLinks
    http/v1/posts.ts                           # Posts endpoints
    http/v1/subscribe.ts                       # Subscribe proxy to NoD
    dev/fixtures.ts                            # LiveFixture type + loader
    dev/fixture-world.ts                       # fixtures → events (compat tests + dev seed)
    import/queries.ts, import/map.ts, import/run.ts, import/cli.ts   # legacy importer
    app.ts, main.ts
  test/
    helpers.ts                                 # test DB, signed event sender, app factory
    normalize.ts                               # compat comparison normalizer
    compat.test.ts                             # live-fixture compatibility suite
    fixtures/live/*.json                       # recorded (committed)
```

---

### Task 1: Release and site-content events in the catalogue

**Files:**
- Modify: `packages/events/src/catalogue.ts`, `packages/events/package.json` (add export `"./testing": "./src/testing.ts"`)
- Create: `packages/events/src/testing.ts` (shared `sampleRelease` fixture; not a test file, so importing it never re-runs tests)
- Test: `packages/events/src/catalogue-release.test.ts`

**Interfaces:**
- Produces (from `@gcpe/events`):
  - `postKindSchema` (`"releases" | "stories" | "factsheets" | "updates" | "advisories"`), `type PostKind`
  - `documentContactSchema`, `releaseDocumentSchema`, `assetSchema`
  - `releaseRecordSchema` / `type ReleaseRecord` with fields: `key, kind, reference, atomId, publishDate, leadMinistryKey, summary, socialMediaSummary, socialMediaHeadline, keywords, location, hasMediaAssets, hasTranslations, isNewsOnDemand, assetUrl, redirectUri, documents, ministryKeys, sectorKeys, tagKeys, themeKeys, assets, translations, publishFlags {toWeb,toSubscribers,toMediaLists}, mediaListKeys, renditions {htmlUrl,textUrl,pdfUrl} | null, timestamp`
  - `categoryKindSchema` (`"ministries" | "sectors" | "themes" | "tags"`), `type CategoryKind`
  - `slideRecordSchema` / `type SlideRecord` (`id` uuid, `sortIndex`, `headline`, `summary`, `actionLabel`, `actionUri`, `imageBase64`, `imageType`, `facebookPostUri`, `justify`, `timestamp`)
  - `siteContentChangedSchema` / `type SiteContentChanged`: discriminated on `entity` ∈ `home | slides | resourceLinks | categoryFeatures`
  - Catalogue entries: `release.published` (ReleaseRecord), `release.updated` (ReleaseRecord + `notify: boolean`), `release.unpublished` (`{ key }`), `site.content.changed`
  - Aggregate id conventions (documented here; producers follow them): `release:<key>`, `site:home`, `site:slides`, `site:resourceLinks`, `site:feature:<kind>:<key>`

- [ ] **Step 1: Write the failing test**

`packages/events/src/testing.ts`:
```ts
import type { ReleaseRecord } from "./catalogue";

export const sampleRelease: ReleaseRecord = {
  key: "2026TT0103-001121",
  kind: "releases",
  reference: "NEWS-34336",
  atomId: "uuid:9af8cc16-0ae5-4ec6-ad58-fdb081d44e37",
  publishDate: "2026-10-01T15:10:00-07:00",
  leadMinistryKey: "transportation-and-transit",
  summary: "Drivers can expect major traffic-pattern changes on Highway 11.",
  socialMediaSummary: null,
  socialMediaHeadline: null,
  keywords: "",
  location: "Abbotsford",
  hasMediaAssets: false,
  hasTranslations: false,
  isNewsOnDemand: true,
  assetUrl: "",
  redirectUri: null,
  documents: [
    {
      pageTitle: "Traffic Advisory",
      languageId: 4105,
      headline: "Traffic-pattern change planned for Highway 11 at Highway 1",
      subheadline: "",
      detailsHtml: "<p>Drivers can expect…</p>",
      byline: "",
      contacts: [{ title: "Ministry of Transportation and Transit", details: "Media Relations\n250-356-8241" }],
    },
  ],
  ministryKeys: ["transportation-and-transit"],
  sectorKeys: ["government-operations", "services"],
  tagKeys: [],
  themeKeys: [],
  assets: null,
  translations: null,
  publishFlags: { toWeb: true, toSubscribers: true, toMediaLists: false },
  mediaListKeys: [],
  renditions: null,
  timestamp: "2026-10-01T15:10:28.0375661-07:00",
};
```

In `packages/events/package.json` set `"exports": { ".": "./src/index.ts", "./tables": "./src/tables.ts", "./testing": "./src/testing.ts" }`.

`packages/events/src/catalogue-release.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseEvent } from "./index";
import { sampleRelease } from "./testing";

function env(type: string, data: unknown) {
  return {
    id: "6f0d7f4e-8a51-4d39-9f42-2a4f4c1c0b11",
    type,
    version: 1,
    source: "nrms",
    aggregateId: "release:x",
    sequence: 1,
    occurredAt: "2026-10-02T17:00:00Z",
    correlationId: "0b8f3f86-2d1e-4b59-9e0c-5d6f1b1c2a33",
    data,
  };
}

describe("release and site events", () => {
  it("accepts release.published, including 7-digit fractional timestamps", () => {
    expect(parseEvent(env("release.published", sampleRelease)).data).toEqual(sampleRelease);
  });

  it("rejects an unknown post kind", () => {
    expect(() => parseEvent(env("release.published", { ...sampleRelease, kind: "news" }))).toThrow();
  });

  it("requires notify on release.updated", () => {
    expect(() => parseEvent(env("release.updated", sampleRelease))).toThrow();
    expect(parseEvent(env("release.updated", { ...sampleRelease, notify: false })).type).toBe("release.updated");
  });

  it("validates site.content.changed by entity", () => {
    expect(
      parseEvent(env("site.content.changed", { entity: "categoryFeatures", kind: "ministries", key: "health", topPostKey: "a", featurePostKey: null })).data,
    ).toMatchObject({ entity: "categoryFeatures" });
    expect(() => parseEvent(env("site.content.changed", { entity: "banner" }))).toThrow();
    expect(() =>
      parseEvent(env("site.content.changed", { entity: "slides", slides: [{ id: "not-a-uuid", sortIndex: 0 }] })),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/events/src/catalogue-release.test.ts`
Expected: FAIL — `release.published` passes through unvalidated, so "rejects an unknown post kind" fails; `ReleaseRecord` type missing (type error is fine at this step).

- [ ] **Step 3: Extend the catalogue**

In `packages/events/src/catalogue.ts`, add before `export const eventDataSchemas`:
```ts
export const postKindSchema = z.enum(["releases", "stories", "factsheets", "updates", "advisories"]);
export type PostKind = z.infer<typeof postKindSchema>;

export const documentContactSchema = z.object({ title: z.string().nullable(), details: z.string().nullable() });

export const releaseDocumentSchema = z.object({
  pageTitle: z.string().nullable(),
  languageId: z.number().int(),
  headline: z.string().nullable(),
  subheadline: z.string().nullable(),
  detailsHtml: z.string().nullable(),
  byline: z.string().nullable(),
  contacts: z.array(documentContactSchema),
});

export const assetSchema = z.object({ key: z.string().nullable(), label: z.string().nullable(), length: z.number().int().nullable() });

const offsetDateTime = z.string().datetime({ offset: true });

export const releaseRecordSchema = z.object({
  key: z.string().min(1),
  kind: postKindSchema,
  reference: z.string().nullable(),
  atomId: z.string().nullable(),
  publishDate: offsetDateTime,
  leadMinistryKey: z.string().nullable(),
  summary: z.string().nullable(),
  socialMediaSummary: z.string().nullable(),
  socialMediaHeadline: z.string().nullable(),
  keywords: z.string().nullable(),
  location: z.string().nullable(),
  hasMediaAssets: z.boolean(),
  hasTranslations: z.boolean(),
  isNewsOnDemand: z.boolean(),
  assetUrl: z.string().nullable(),
  redirectUri: z.string().nullable(),
  documents: z.array(releaseDocumentSchema),
  ministryKeys: z.array(z.string()),
  sectorKeys: z.array(z.string()),
  tagKeys: z.array(z.string()),
  themeKeys: z.array(z.string()),
  assets: z.array(assetSchema).nullable(),
  translations: z.array(assetSchema).nullable(),
  publishFlags: z.object({ toWeb: z.boolean(), toSubscribers: z.boolean(), toMediaLists: z.boolean() }),
  mediaListKeys: z.array(z.string()),
  renditions: z.object({ htmlUrl: z.string().nullable(), textUrl: z.string().nullable(), pdfUrl: z.string().nullable() }).nullable(),
  timestamp: offsetDateTime,
});
export type ReleaseRecord = z.infer<typeof releaseRecordSchema>;

export const categoryKindSchema = z.enum(["ministries", "sectors", "themes", "tags"]);
export type CategoryKind = z.infer<typeof categoryKindSchema>;

export const slideRecordSchema = z.object({
  id: z.string().uuid(),
  sortIndex: z.number().int(),
  headline: z.string().nullable(),
  summary: z.string().nullable(),
  actionLabel: z.string().nullable(),
  actionUri: z.string().nullable(),
  imageBase64: z.string().nullable(),
  imageType: z.string().nullable(),
  facebookPostUri: z.string().nullable(),
  justify: z.string().nullable(),
  timestamp: offsetDateTime,
});
export type SlideRecord = z.infer<typeof slideRecordSchema>;

export const siteContentChangedSchema = z.discriminatedUnion("entity", [
  z.object({
    entity: z.literal("home"),
    topPostKey: z.string().nullable(),
    featurePostKey: z.string().nullable(),
    liveWebcastFlashMediaManifestUrl: z.string().nullable(),
    liveWebcastM3uPlaylist: z.string().nullable(),
    granville: z.string().nullable(),
    timestamp: offsetDateTime,
  }),
  z.object({ entity: z.literal("slides"), slides: z.array(slideRecordSchema) }),
  z.object({
    entity: z.literal("resourceLinks"),
    links: z.array(z.object({ sortIndex: z.number().int(), text: z.string(), uri: z.string() })),
    timestamp: offsetDateTime,
  }),
  z.object({
    entity: z.literal("categoryFeatures"),
    kind: categoryKindSchema,
    key: z.string().min(1),
    topPostKey: z.string().nullable(),
    featurePostKey: z.string().nullable(),
  }),
]);
export type SiteContentChanged = z.infer<typeof siteContentChangedSchema>;
```

Add to the `eventDataSchemas` object:
```ts
  "release.published": releaseRecordSchema,
  "release.updated": releaseRecordSchema.extend({ notify: z.boolean() }),
  "release.unpublished": z.object({ key: z.string().min(1) }),
  "site.content.changed": siteContentChangedSchema,
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/events && npm run check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/events
git commit -m "feat(events): release and site-content event schemas"
```

---

### Task 2: Record live News API fixtures

**Files:**
- Create: `apps/news-api/package.json`, `apps/news-api/src/dev/fixtures.ts`, `apps/news-api/scripts/record-live-fixtures.ts`
- Create (recorded data): `apps/news-api/test/fixtures/live/*.json`
- Test: `apps/news-api/src/dev/fixtures.test.ts`

**Interfaces:**
- Produces:
  - `interface LiveFixture { name: string; path: string; status: number; contentType: string | null; body: unknown }`
  - `loadLiveFixtures(dir?: string): Record<string, LiveFixture>` (default dir `apps/news-api/test/fixtures/live`)
  - Fixture names (exact): `latest-home`, `post-first`, `post-first-lowercase`, `posts-multi`, `post-unknown`, `featured-posts`, `keys-reference`, `keys-reference-unknown`, `latest-ministry-health`, `latest-home-factsheets`, `latest-home-stories`, `latest-home-updates`, `keys-home`, `keys-home-skip`, `keys-home-advisories`, `keys-ministry-health-upper`, `keys-theme-unknown`, `keys-unknown-kind`, `latest-media-video`, `home`, `home-no-version`, `home-bad-version`, `ministries`, `ministry-health`, `minister-health`, `ministry-unknown`, `sectors`, `sector-first`, `sector-unknown`, `themes`, `theme-first`, `theme-unknown`, `tags`, `tag-first`, `tag-unknown`, `slides`, `slide-first`, `slide-unknown`, `resource-links`

- [ ] **Step 1: Package manifest**

`apps/news-api/package.json`:
```json
{
  "name": "@gcpe/news-api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "db:generate": "drizzle-kit generate",
    "record:fixtures": "tsx scripts/record-live-fixtures.ts",
    "seed:fixtures": "tsx scripts/seed-from-fixtures.ts",
    "import:legacy": "tsx src/import/cli.ts",
    "build": "node ../../scripts/build-app.mjs apps/news-api"
  },
  "dependencies": {
    "@gcpe/auth": "0.0.0",
    "@gcpe/config": "0.0.0",
    "@gcpe/db-kit": "0.0.0",
    "@gcpe/events": "0.0.0",
    "@gcpe/legacy-import": "0.0.0",
    "drizzle-orm": "^0.45.2",
    "express": "^5.2.1",
    "express-rate-limit": "^8.3.1",
    "pg": "^8.16.3",
    "ws": "^8.18.3",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@microsoft/signalr": "^10.0.11",
    "@types/express": "^5.0.6",
    "@types/pg": "^8.23.1",
    "@types/supertest": "^7.2.1",
    "@types/ws": "^8.18.2",
    "drizzle-kit": "^0.31.9",
    "supertest": "^7.1.0"
  }
}
```

Run: `npm install`

- [ ] **Step 2: Write the fixture loader and its failing test**

`apps/news-api/src/dev/fixtures.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { loadLiveFixtures } from "./fixtures";

describe("loadLiveFixtures", () => {
  it("loads every recorded fixture with the expected names", () => {
    const fx = loadLiveFixtures();
    for (const name of ["latest-home", "post-first", "ministries", "minister-health", "slides", "resource-links", "home-no-version"]) {
      expect(fx[name], name).toBeDefined();
    }
    expect(fx["home-no-version"]!.status).toBe(400);
    expect(fx["post-unknown"]!.body).toBeNull();
  });
});
```

`apps/news-api/src/dev/fixtures.ts`:
```ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface LiveFixture {
  name: string;
  path: string;
  status: number;
  contentType: string | null;
  body: unknown;
}

export const DEFAULT_FIXTURE_DIR = new URL("../../test/fixtures/live/", import.meta.url).pathname;

export function loadLiveFixtures(dir: string = DEFAULT_FIXTURE_DIR): Record<string, LiveFixture> {
  const out: Record<string, LiveFixture> = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const fx = JSON.parse(readFileSync(join(dir, file), "utf8")) as LiveFixture;
    out[fx.name] = fx;
  }
  return out;
}
```

- [ ] **Step 3: Write the recorder**

`apps/news-api/scripts/record-live-fixtures.ts`:
```ts
// Records public, read-only GET responses from the live BC Gov News API (1 request/second).
// Slide `image` fields are truncated to 400 base64 chars to keep fixtures small (still valid base64).
import { mkdirSync, writeFileSync } from "node:fs";
import { DEFAULT_FIXTURE_DIR, type LiveFixture } from "../src/dev/fixtures";

const BASE = process.env.NEWS_API_LIVE_BASE ?? "https://api.news.gov.bc.ca";
const V = "api-version=1.0";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function truncateImages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(truncateImages);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, k === "image" && typeof v === "string" ? v.slice(0, 400) : truncateImages(v)]),
    );
  }
  return value;
}

async function record(name: string, path: string): Promise<LiveFixture> {
  const res = await fetch(BASE + path);
  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = truncateImages(JSON.parse(text));
    } catch {
      body = text;
    }
  }
  const fixture: LiveFixture = { name, path, status: res.status, contentType: res.headers.get("content-type"), body };
  writeFileSync(`${DEFAULT_FIXTURE_DIR}${name}.json`, JSON.stringify(fixture, null, 2) + "\n");
  console.log(res.status, name);
  await sleep(1000);
  return fixture;
}

type Keyed = { key: string; reference?: string; topPostKey?: string | null; featurePostKey?: string | null };

mkdirSync(DEFAULT_FIXTURE_DIR, { recursive: true });

const home = (await record("home", `/api/Home?${V}`)).body as Keyed;
await record("home-no-version", `/api/Home`);
await record("home-bad-version", `/api/Home?api-version=2.0`);
const health = (await record("ministry-health", `/api/Ministries/health?${V}`)).body as Keyed;
await record("ministries", `/api/Ministries?${V}`);
await record("minister-health", `/api/Ministries/health/Minister?${V}`);
await record("ministry-unknown", `/api/Ministries/zz-unknown?${V}`);

const featured = [home.topPostKey, home.featurePostKey, health.topPostKey, health.featurePostKey].filter((k): k is string => !!k);
await record("featured-posts", `/api/Posts?postKeys=${featured.join(",")}&${V}`);

const latest = (await record("latest-home", `/api/Posts/Latest/home/default?count=3&${V}`)).body as Keyed[];
const first = latest[0]!;
const second = latest[1]!;
await record("post-first", `/api/Posts/${first.key}?${V}`);
await record("post-first-lowercase", `/api/Posts/${first.key.toLowerCase()}?${V}`);
await record("posts-multi", `/api/Posts?postKeys=${second.key},zz-unknown,${first.key.toLowerCase()}&${V}`);
await record("post-unknown", `/api/Posts/zz-unknown-key?${V}`);
await record("keys-reference", `/api/Posts/Keys/${first.reference!.toLowerCase()}?${V}`);
await record("keys-reference-unknown", `/api/Posts/Keys/NEWS-0?${V}`);
await record("latest-ministry-health", `/api/Posts/Latest/ministries/health?count=4&${V}`); // 4 so Keys(count=4) is always covered together with featured-posts
for (const kind of ["factsheets", "stories", "updates"]) {
  await record(`latest-home-${kind}`, `/api/Posts/Latest/home/default?postKind=${kind}&count=1&${V}`);
}
await record("keys-home", `/api/Posts/Keys/home/default?count=3&${V}`);
await record("keys-home-skip", `/api/Posts/Keys/home/default?count=2&skip=1&${V}`);
await record("keys-home-advisories", `/api/Posts/Keys/home/default?postKind=advisories&count=3&${V}`);
await record("keys-ministry-health-upper", `/api/Posts/Keys/ministries/HEALTH?count=4&${V}`);
await record("keys-theme-unknown", `/api/Posts/Keys/themes/zz-unknown?count=1&${V}`);
await record("keys-unknown-kind", `/api/Posts/Keys/services/zz?count=1&${V}`);
await record("latest-media-video", `/api/Posts/LatestMediaUri/video?${V}`);

for (const [singular, plural] of [["sector", "Sectors"], ["theme", "Themes"], ["tag", "Tags"]] as const) {
  const list = (await record(`${singular}s`, `/api/${plural}?${V}`)).body as Keyed[];
  await record(`${singular}-first`, `/api/${plural}/${list[0]!.key}?${V}`);
  await record(`${singular}-unknown`, `/api/${plural}/zz-unknown?${V}`);
}
const slides = (await record("slides", `/api/Slides?${V}`)).body as Keyed[];
await record("slide-first", `/api/Slides/${slides[0]!.key.toUpperCase()}?${V}`);
await record("slide-unknown", `/api/Slides/00000000-0000-0000-0000-000000000000?${V}`);
await record("resource-links", `/api/ResourceLinks?${V}`);
```

- [ ] **Step 4: Record fixtures**

Run: `npm --workspace @gcpe/news-api run record:fixtures`
Expected: ~40 lines like `200 home`; `400 home-no-version`; `400 home-bad-version`; `200 post-unknown`; `404 keys-theme-unknown`; `204 latest-media-video`. Files appear in `apps/news-api/test/fixtures/live/`.

Sanity checks to run by hand (these confirm the spec §6.1 observations still hold at recording time):
```bash
cd apps/news-api/test/fixtures/live
node -e 'const f=n=>require("./"+n+".json");const lh=f("latest-home").body.map(p=>p.key);const kh=f("keys-home").body.map(p=>p.key);const h=f("home").body;console.log("latest excludes home feature:",!lh.includes(h.featurePostKey),"keys includes it?",kh.includes(h.featurePostKey))'
```
Expected: `latest excludes home feature: true`. (`keys includes it?` is `true` only when the feature post is among the newest three; either value is acceptable.)

- [ ] **Step 5: Run the loader test**

Run: `npx vitest run apps/news-api/src/dev`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/news-api package-lock.json
git commit -m "test(news-api): recorder and recorded live News API fixtures"
```

---

### Task 3: News API schema, time formatting, test helpers

**Files:**
- Create: `apps/news-api/drizzle.config.ts`, `apps/news-api/src/db/schema.ts`, `apps/news-api/src/time.ts`
- Create (generated): `apps/news-api/migrations/*`
- Create: `apps/news-api/test/helpers.ts`
- Test: `apps/news-api/src/time.test.ts`

**Interfaces:**
- Produces:
  - Tables `posts`, `categories`, `categoryFeatures`, `home`, `slides`, `resourceLinks` (+ event tables); types `PostRow`, `CategoryRow`, `FeatureRow`, `HomeRow`, `SlideRow`, `ResourceLinkRow`, `MinistryDetails`
  - `posts.indexKeys`: lowercased `"<kind>:<key>"` entries (`ministries:health`, `sectors:economy`, …) for case-insensitive index lookups
  - `formatOffsetDateTime(date: Date, timeZone: string): string` — `YYYY-MM-DDTHH:mm:ss[.SSS]±HH:MM`, fraction omitted when ms = 0
  - `parseOffsetDateTime(value: string): Date` — accepts any number of fractional digits (truncates to ms)
  - Test helpers: `newsMigrations`, `createNewsTestDb(): Promise<TestDatabase>`, `TZ = "America/Vancouver"`

- [ ] **Step 1: Write the failing time test**

`apps/news-api/src/time.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { formatOffsetDateTime, parseOffsetDateTime } from "./time";

describe("time", () => {
  it("formats in the tenant zone, omitting zero milliseconds (matches live publishDate)", () => {
    expect(formatOffsetDateTime(new Date("2026-10-01T22:10:00Z"), "America/Vancouver")).toBe("2026-10-01T15:10:00-07:00");
  });

  it("keeps milliseconds and switches to PST in winter", () => {
    expect(formatOffsetDateTime(new Date("2026-01-15T20:00:00.123Z"), "America/Vancouver")).toBe("2026-01-15T12:00:00.123-08:00");
  });

  it("renders UTC as +00:00", () => {
    expect(formatOffsetDateTime(new Date("2026-01-15T20:00:00Z"), "UTC")).toBe("2026-01-15T20:00:00+00:00");
  });

  it("parses .NET 7-digit fractions", () => {
    expect(parseOffsetDateTime("2026-10-01T15:10:28.0375661-07:00").toISOString()).toBe("2026-10-01T22:10:28.037Z");
  });

  it("rejects garbage", () => {
    expect(() => parseOffsetDateTime("yesterday")).toThrow(/Invalid date/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/news-api/src/time.test.ts`
Expected: FAIL — cannot resolve `./time`.

- [ ] **Step 3: Implement time helpers**

`apps/news-api/src/time.ts`:
```ts
export function formatOffsetDateTime(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const zone = parts.timeZoneName ?? "GMT";
  const offset = zone === "GMT" ? "+00:00" : zone.replace("GMT", "");
  const ms = date.getUTCMilliseconds();
  const fraction = ms === 0 ? "" : `.${String(ms).padStart(3, "0")}`;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${fraction}${offset}`;
}

export function parseOffsetDateTime(value: string): Date {
  const normalized = value.replace(/(\.\d{3})\d+/, "$1");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}
```

- [ ] **Step 4: Write the schema**

`apps/news-api/drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({ dialect: "postgresql", schema: "./src/db/schema.ts", out: "./migrations" });
```

`apps/news-api/src/db/schema.ts`:
```ts
import { sql } from "drizzle-orm";
import { boolean, customType, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { OrgRecord, ReleaseRecord } from "@gcpe/events";

export * from "@gcpe/events/tables";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const posts = pgTable(
  "posts",
  {
    key: text("key").primaryKey(),
    kind: text("kind").notNull(),
    reference: text("reference"),
    atomId: text("atom_id"),
    publishDate: timestamp("publish_date", { withTimezone: true }).notNull(),
    leadMinistryKey: text("lead_ministry_key"),
    summary: text("summary"),
    socialMediaSummary: text("social_media_summary"),
    socialMediaHeadline: text("social_media_headline"),
    keywords: text("keywords"),
    location: text("location"),
    hasMediaAssets: boolean("has_media_assets").notNull(),
    hasTranslations: boolean("has_translations").notNull(),
    isNewsOnDemand: boolean("is_news_on_demand").notNull(),
    assetUrl: text("asset_url"),
    redirectUri: text("redirect_uri"),
    documents: jsonb("documents").$type<ReleaseRecord["documents"]>().notNull(),
    ministryKeys: text("ministry_keys").array().notNull(),
    sectorKeys: text("sector_keys").array().notNull(),
    tagKeys: text("tag_keys").array().notNull(),
    themeKeys: text("theme_keys").array().notNull(),
    indexKeys: text("index_keys").array().notNull(),
    assets: jsonb("assets").$type<ReleaseRecord["assets"]>(),
    translations: jsonb("translations").$type<ReleaseRecord["translations"]>(),
    isPublished: boolean("is_published").notNull().default(true),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("posts_key_lower_idx").on(sql`lower(${t.key})`),
    index("posts_reference_lower_idx").on(sql`lower(${t.reference})`),
    index("posts_publish_date_idx").on(t.publishDate.desc()),
    index("posts_index_keys_idx").using("gin", t.indexKeys),
  ],
);

export type MinistryDetails = Pick<
  OrgRecord,
  "parentKey" | "url" | "displayAdditionalName" | "minister" | "contact" | "secondContact" | "weekendContactNumber" | "topicLinks" | "serviceLinks"
>;

export const categories = pgTable(
  "categories",
  {
    kind: text("kind").notNull(), // ministries | sectors | themes | tags
    key: text("key").notNull(),
    name: text("name"),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull(),
    social: jsonb("social").$type<OrgRecord["social"]>().notNull(),
    ministry: jsonb("ministry").$type<MinistryDetails | null>(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.key] }), uniqueIndex("categories_kind_key_lower_idx").on(t.kind, sql`lower(${t.key})`)],
);

export const categoryFeatures = pgTable(
  "category_features",
  {
    kind: text("kind").notNull(),
    key: text("key").notNull(), // stored lowercased
    topPostKey: text("top_post_key"),
    featurePostKey: text("feature_post_key"),
  },
  (t) => [primaryKey({ columns: [t.kind, t.key] })],
);

export const home = pgTable("home", {
  key: text("key").primaryKey().default("default"),
  topPostKey: text("top_post_key"),
  featurePostKey: text("feature_post_key"),
  liveWebcastFlashMediaManifestUrl: text("live_webcast_flash_media_manifest_url"),
  liveWebcastM3uPlaylist: text("live_webcast_m3u_playlist"),
  granville: text("granville"),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
});

export const slides = pgTable("slides", {
  id: uuid("id").primaryKey(),
  sortIndex: integer("sort_index").notNull(),
  headline: text("headline"),
  summary: text("summary"),
  actionLabel: text("action_label"),
  actionUri: text("action_uri"),
  image: bytea("image"),
  imageType: text("image_type"),
  facebookPostUri: text("facebook_post_uri"),
  justify: text("justify"),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
});

export const resourceLinks = pgTable("resource_links", {
  sortIndex: integer("sort_index").primaryKey(),
  text: text("text").notNull(),
  uri: text("uri").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
});

export type PostRow = typeof posts.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
export type FeatureRow = typeof categoryFeatures.$inferSelect;
export type HomeRow = typeof home.$inferSelect;
export type SlideRow = typeof slides.$inferSelect;
export type ResourceLinkRow = typeof resourceLinks.$inferSelect;
```

- [ ] **Step 5: Generate migrations and write test helpers**

Run: `npm --workspace @gcpe/news-api run db:generate -- --name init`
Expected: `apps/news-api/migrations/0000_init.sql` with `posts`, `categories`, `category_features`, `home`, `slides`, `resource_links`, the event tables, and `CREATE INDEX ... USING gin ("index_keys")`.

`apps/news-api/test/helpers.ts`:
```ts
import { randomUUID } from "node:crypto";
import type express from "express";
import request from "supertest";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { signPayload } from "@gcpe/events";

export const TZ = "America/Vancouver";
export const EVENT_SECRETS = { core: "core-secret", nrms: "nrms-secret" } as const;
export const newsMigrations = new URL("../migrations", import.meta.url).pathname;

export function createNewsTestDb(): Promise<TestDatabase> {
  return createTestDatabase({ migrationsFolder: newsMigrations });
}

let seq = 0;
export function envelope(source: "core" | "nrms", type: string, aggregateId: string, data: unknown) {
  return {
    id: randomUUID(),
    type,
    version: 1,
    source,
    aggregateId,
    sequence: ++seq,
    occurredAt: new Date().toISOString(),
    correlationId: randomUUID(),
    data,
  };
}

export async function sendEvent(app: express.Express, event: ReturnType<typeof envelope>) {
  const body = JSON.stringify(event);
  const ts = new Date().toISOString();
  const res = await request(app)
    .post("/events")
    .set("content-type", "application/json")
    .set("x-event-source", event.source)
    .set("x-event-timestamp", ts)
    .set("x-signature", signPayload(EVENT_SECRETS[event.source], ts, body))
    .send(body);
  if (res.status !== 200) throw new Error(`event ${event.type} rejected: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { outcome: string };
}
```

(`sequence` increases globally across the test run, which satisfies per-aggregate ordering.)

- [ ] **Step 6: Run tests**

Run: `npx vitest run apps/news-api && npm run check`
Expected: time tests and fixture loader test PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/news-api
git commit -m "feat(news-api): schema, migrations, tenant-zone time formatting, test helpers"
```

---

### Task 4: Projections and update notifications

**Files:**
- Create: `apps/news-api/src/updates/notify.ts`, `apps/news-api/src/projections.ts`
- Test: `apps/news-api/src/projections.test.ts`

**Interfaces:**
- Consumes: event types/schemas (Task 1, Phase 0 Task 3); tables (Task 3); `parseOffsetDateTime`.
- Produces:
  - `type UpdateTarget = "PostUpdate" | "MinisterUpdate" | "HomeUpdate" | "SlideUpdate" | "ResourceLinkUpdate" | "ThemeUpdate" | "TagUpdate" | "SectorUpdate" | "MinistryUpdate"`
  - `UPDATES_CHANNEL = "news_api_updates"`
  - `notifyUpdate(tx: DbOrTx, target: UpdateTarget, keys: string[]): Promise<void>` (pg_notify — delivered on commit)
  - `listenForUpdates(pool: pg.Pool, onUpdate: (target: UpdateTarget, keys: string[]) => void): Promise<() => Promise<void>>`
  - `indexKeysFor(r: Pick<ReleaseRecord, "ministryKeys" | "sectorKeys" | "tagKeys" | "themeKeys">): string[]`
  - `applyOrg(tx, org: OrgRecord)`, `applyTerm(tx, term: TermRecord)`, `deactivateCategory(tx, kind: CategoryKind, key: string)`, `applyRelease(tx, r: ReleaseRecord)`, `unpublishRelease(tx, key: string)`, `applySiteContent(tx, c: SiteContentChanged)` — all `Promise<void>`
  - `createProjectionHandlers(): Record<string, EventHandler>` keyed by event type
  - `TERM_TO_CATEGORY: Record<TermKind, CategoryKind | null>` (`service → null`: services have no News API endpoint)

- [ ] **Step 1: Write the failing test**

`apps/news-api/src/projections.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { OrgRecord, ReleaseRecord } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { createNewsTestDb } from "../test/helpers";
import { categories, categoryFeatures, home, posts, resourceLinks, slides } from "./db/schema";
import { applyOrg, applyRelease, applySiteContent, applyTerm, indexKeysFor, unpublishRelease } from "./projections";
import { listenForUpdates, type UpdateTarget } from "./updates/notify";

const org: OrgRecord = {
  key: "health", displayName: "Health", abbreviation: "HLTH", sortOrder: 5, isActive: true, parentKey: null, url: "http://gov.bc.ca/health",
  displayAdditionalName: null,
  minister: { name: "Honourable Ravi Kahlon", summary: "Honourable Ravi Kahlon", detailsHtml: "<p>bio</p>", email: "HLTH.Minister@gov.bc.ca", photoUrl: null, address: "PO BOX 9050" },
  contact: null, secondContact: null, weekendContactNumber: "", social: { twitterUsername: "", flickrUrl: null, youtubeUrl: null, audioUrl: null },
  topicLinks: [], serviceLinks: [], sectorKeys: [], updatedAt: "2026-10-02T16:46:05.527-07:00",
};

describe("projections", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE posts, categories, category_features, home, slides, resource_links");
  });

  it("builds lowercased index keys", () => {
    expect(indexKeysFor({ ministryKeys: ["Health"], sectorKeys: ["economy"], tagKeys: [], themeKeys: ["T1"] })).toEqual([
      "ministries:health",
      "sectors:economy",
      "themes:t1",
    ]);
  });

  it("upserts a release and unpublishes it", async () => {
    await tdb.db.transaction((tx) => applyRelease(tx, sampleRelease));
    await tdb.db.transaction((tx) => applyRelease(tx, { ...sampleRelease, summary: "changed" }));
    const [row] = await tdb.db.select().from(posts).where(eq(posts.key, sampleRelease.key));
    expect(row!.summary).toBe("changed");
    expect(row!.indexKeys).toContain("ministries:transportation-and-transit");
    expect(row!.timestamp.toISOString()).toBe("2026-10-01T22:10:28.037Z");
    await tdb.db.transaction((tx) => unpublishRelease(tx, sampleRelease.key.toLowerCase()));
    const [after] = await tdb.db.select().from(posts).where(eq(posts.key, sampleRelease.key));
    expect(after!.isPublished).toBe(false);
  });

  it("projects an org into categories with ministry details", async () => {
    await tdb.db.transaction((tx) => applyOrg(tx, org));
    const [row] = await tdb.db.select().from(categories).where(eq(categories.key, "health"));
    expect(row).toMatchObject({ kind: "ministries", name: "Health", sortOrder: 5, isActive: true });
    expect(row!.ministry!.minister.email).toBe("HLTH.Minister@gov.bc.ca");
  });

  it("ignores service terms", async () => {
    await tdb.db.transaction((tx) =>
      applyTerm(tx, { kind: "service", key: "x", displayName: "X", sortOrder: 0, isActive: true, social: org.social, updatedAt: org.updatedAt }),
    );
    expect(await tdb.db.select().from(categories)).toHaveLength(0);
  });

  it("applies each site content entity", async () => {
    await tdb.db.transaction(async (tx) => {
      await applySiteContent(tx, { entity: "home", topPostKey: "a", featurePostKey: "b", liveWebcastFlashMediaManifestUrl: null, liveWebcastM3uPlaylist: null, granville: null, timestamp: "2026-10-02T10:34:49.0859062-07:00" });
      await applySiteContent(tx, { entity: "categoryFeatures", kind: "ministries", key: "Health", topPostKey: "t", featurePostKey: "f" });
      await applySiteContent(tx, {
        entity: "slides",
        slides: [{ id: "f9adfdc2-5933-4c38-a390-a18077acb213", sortIndex: 0, headline: "Get vaccinated", summary: "s", actionLabel: "READ MORE", actionUri: "https://x", imageBase64: "iVBORw0KGgo=", imageType: "image/png", facebookPostUri: null, justify: "right", timestamp: "2026-09-09T16:31:07.5216222-07:00" }],
      });
      await applySiteContent(tx, { entity: "resourceLinks", links: [{ sortIndex: 0, text: "Factsheets", uri: "/factsheets" }], timestamp: "2026-10-02T00:00:00Z" });
    });
    expect((await tdb.db.select().from(home))[0]!.featurePostKey).toBe("b");
    expect((await tdb.db.select().from(categoryFeatures))[0]).toEqual({ kind: "ministries", key: "health", topPostKey: "t", featurePostKey: "f" });
    expect((await tdb.db.select().from(slides))[0]!.image!.toString("base64")).toBe("iVBORw0KGgo=");
    expect(await tdb.db.select().from(resourceLinks)).toHaveLength(1);
  });

  it("notifies listeners only after commit", async () => {
    const got: [UpdateTarget, string[]][] = [];
    const stop = await listenForUpdates(tdb.pool, (t, k) => got.push([t, k]));
    await expect(
      tdb.db.transaction(async (tx) => {
        await applyRelease(tx, { ...sampleRelease, key: "rolled-back" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await tdb.db.transaction((tx) => applyRelease(tx, sampleRelease));
    await new Promise((r) => setTimeout(r, 200));
    await stop();
    expect(got).toEqual([["PostUpdate", [sampleRelease.key]]]);
  });
});
```

Note: `sampleRelease` comes from `@gcpe/events/testing` (Task 1) so both packages share one canonical fixture.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/news-api/src/projections.test.ts`
Expected: FAIL — cannot resolve `./projections`.

- [ ] **Step 3: Implement notify**

`apps/news-api/src/updates/notify.ts`:
```ts
import { sql } from "drizzle-orm";
import type pg from "pg";
import type { DbOrTx } from "@gcpe/db-kit";

export type UpdateTarget =
  | "PostUpdate"
  | "MinisterUpdate"
  | "HomeUpdate"
  | "SlideUpdate"
  | "ResourceLinkUpdate"
  | "ThemeUpdate"
  | "TagUpdate"
  | "SectorUpdate"
  | "MinistryUpdate";

export const UPDATES_CHANNEL = "news_api_updates";

export async function notifyUpdate(tx: DbOrTx, target: UpdateTarget, keys: string[]): Promise<void> {
  await tx.execute(sql`SELECT pg_notify(${UPDATES_CHANNEL}, ${JSON.stringify({ target, keys })})`);
}

export async function listenForUpdates(
  pool: pg.Pool,
  onUpdate: (target: UpdateTarget, keys: string[]) => void,
): Promise<() => Promise<void>> {
  const client = await pool.connect();
  client.on("notification", (msg) => {
    if (msg.channel !== UPDATES_CHANNEL || !msg.payload) return;
    const { target, keys } = JSON.parse(msg.payload) as { target: UpdateTarget; keys: string[] };
    onUpdate(target, keys);
  });
  client.on("error", (e) => console.error("[news-api] LISTEN connection error", e));
  await client.query(`LISTEN ${UPDATES_CHANNEL}`);
  return async () => {
    await client.query(`UNLISTEN ${UPDATES_CHANNEL}`);
    client.release();
  };
}
```

- [ ] **Step 4: Implement projections**

`apps/news-api/src/projections.ts`:
```ts
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@gcpe/db-kit";
import type { CategoryKind, EventHandler, OrgRecord, ReleaseRecord, SiteContentChanged, TermKind, TermRecord } from "@gcpe/events";
import { categories, categoryFeatures, home, posts, resourceLinks, slides } from "./db/schema";
import { parseOffsetDateTime } from "./time";
import { notifyUpdate, type UpdateTarget } from "./updates/notify";

export const TERM_TO_CATEGORY: Record<TermKind, CategoryKind | null> = { sector: "sectors", theme: "themes", tag: "tags", service: null };

const CATEGORY_TARGET: Record<CategoryKind, UpdateTarget> = {
  ministries: "MinistryUpdate",
  sectors: "SectorUpdate",
  themes: "ThemeUpdate",
  tags: "TagUpdate",
};

export function indexKeysFor(r: Pick<ReleaseRecord, "ministryKeys" | "sectorKeys" | "tagKeys" | "themeKeys">): string[] {
  return [
    ...r.ministryKeys.map((k) => `ministries:${k}`),
    ...r.sectorKeys.map((k) => `sectors:${k}`),
    ...r.tagKeys.map((k) => `tags:${k}`),
    ...r.themeKeys.map((k) => `themes:${k}`),
  ].map((s) => s.toLowerCase());
}

export async function applyRelease(tx: Tx, r: ReleaseRecord): Promise<void> {
  const values = {
    key: r.key,
    kind: r.kind,
    reference: r.reference,
    atomId: r.atomId,
    publishDate: parseOffsetDateTime(r.publishDate),
    leadMinistryKey: r.leadMinistryKey,
    summary: r.summary,
    socialMediaSummary: r.socialMediaSummary,
    socialMediaHeadline: r.socialMediaHeadline,
    keywords: r.keywords,
    location: r.location,
    hasMediaAssets: r.hasMediaAssets,
    hasTranslations: r.hasTranslations,
    isNewsOnDemand: r.isNewsOnDemand,
    assetUrl: r.assetUrl,
    redirectUri: r.redirectUri,
    documents: r.documents,
    ministryKeys: r.ministryKeys,
    sectorKeys: r.sectorKeys,
    tagKeys: r.tagKeys,
    themeKeys: r.themeKeys,
    indexKeys: indexKeysFor(r),
    assets: r.assets,
    translations: r.translations,
    isPublished: true,
    timestamp: parseOffsetDateTime(r.timestamp),
  };
  await tx.insert(posts).values(values).onConflictDoUpdate({ target: posts.key, set: values });
  await notifyUpdate(tx, "PostUpdate", [r.key]);
}

export async function unpublishRelease(tx: Tx, key: string): Promise<void> {
  const rows = await tx
    .update(posts)
    .set({ isPublished: false })
    .where(sql`lower(${posts.key}) = lower(${key})`)
    .returning({ key: posts.key });
  if (rows.length) await notifyUpdate(tx, "PostUpdate", rows.map((r) => r.key));
}

export async function applyOrg(tx: Tx, org: OrgRecord): Promise<void> {
  const values = {
    kind: "ministries",
    key: org.key,
    name: org.displayName,
    sortOrder: org.sortOrder,
    isActive: org.isActive,
    social: org.social,
    ministry: {
      parentKey: org.parentKey,
      url: org.url,
      displayAdditionalName: org.displayAdditionalName,
      minister: org.minister,
      contact: org.contact,
      secondContact: org.secondContact,
      weekendContactNumber: org.weekendContactNumber,
      topicLinks: org.topicLinks,
      serviceLinks: org.serviceLinks,
    },
    timestamp: parseOffsetDateTime(org.updatedAt),
  };
  await tx.insert(categories).values(values).onConflictDoUpdate({ target: [categories.kind, categories.key], set: values });
  await notifyUpdate(tx, "MinistryUpdate", org.parentKey ? [org.key, org.parentKey] : [org.key]);
  await notifyUpdate(tx, "MinisterUpdate", [org.key]);
}

export async function applyTerm(tx: Tx, term: TermRecord): Promise<void> {
  const kind = TERM_TO_CATEGORY[term.kind];
  if (!kind) return;
  const values = {
    kind,
    key: term.key,
    name: term.displayName,
    sortOrder: term.sortOrder,
    isActive: term.isActive,
    social: term.social,
    ministry: null,
    timestamp: parseOffsetDateTime(term.updatedAt),
  };
  await tx.insert(categories).values(values).onConflictDoUpdate({ target: [categories.kind, categories.key], set: values });
  await notifyUpdate(tx, CATEGORY_TARGET[kind], [term.key]);
}

export async function deactivateCategory(tx: Tx, kind: CategoryKind, key: string): Promise<void> {
  await tx
    .update(categories)
    .set({ isActive: false })
    .where(and(eq(categories.kind, kind), sql`lower(${categories.key}) = lower(${key})`));
  await notifyUpdate(tx, CATEGORY_TARGET[kind], [key]);
}

export async function applySiteContent(tx: Tx, c: SiteContentChanged): Promise<void> {
  switch (c.entity) {
    case "home": {
      const values = {
        key: "default",
        topPostKey: c.topPostKey,
        featurePostKey: c.featurePostKey,
        liveWebcastFlashMediaManifestUrl: c.liveWebcastFlashMediaManifestUrl,
        liveWebcastM3uPlaylist: c.liveWebcastM3uPlaylist,
        granville: c.granville,
        timestamp: parseOffsetDateTime(c.timestamp),
      };
      await tx.insert(home).values(values).onConflictDoUpdate({ target: home.key, set: values });
      await notifyUpdate(tx, "HomeUpdate", ["default"]);
      return;
    }
    case "categoryFeatures": {
      const values = { kind: c.kind, key: c.key.toLowerCase(), topPostKey: c.topPostKey, featurePostKey: c.featurePostKey };
      await tx.insert(categoryFeatures).values(values).onConflictDoUpdate({ target: [categoryFeatures.kind, categoryFeatures.key], set: values });
      await notifyUpdate(tx, CATEGORY_TARGET[c.kind], [c.key]);
      return;
    }
    case "slides": {
      await tx.delete(slides);
      if (c.slides.length) {
        await tx.insert(slides).values(
          c.slides.map((s) => ({
            id: s.id,
            sortIndex: s.sortIndex,
            headline: s.headline,
            summary: s.summary,
            actionLabel: s.actionLabel,
            actionUri: s.actionUri,
            image: s.imageBase64 === null ? null : Buffer.from(s.imageBase64, "base64"),
            imageType: s.imageType,
            facebookPostUri: s.facebookPostUri,
            justify: s.justify,
            timestamp: parseOffsetDateTime(s.timestamp),
          })),
        );
      }
      await notifyUpdate(tx, "SlideUpdate", c.slides.map((s) => s.id));
      return;
    }
    case "resourceLinks": {
      await tx.delete(resourceLinks);
      const ts = parseOffsetDateTime(c.timestamp);
      if (c.links.length) await tx.insert(resourceLinks).values(c.links.map((l) => ({ ...l, timestamp: ts })));
      await notifyUpdate(tx, "ResourceLinkUpdate", []);
      return;
    }
  }
}

export function createProjectionHandlers(): Record<string, EventHandler> {
  const termUpserted: EventHandler = (tx, e) => applyTerm(tx, e.data as TermRecord);
  const termDeactivated: EventHandler = async (tx, e) => {
    const d = e.data as { kind: TermKind; key: string };
    const kind = TERM_TO_CATEGORY[d.kind];
    if (kind) await deactivateCategory(tx, kind, d.key);
  };
  return {
    "org.upserted": (tx, e) => applyOrg(tx, e.data as OrgRecord),
    "org.deactivated": (tx, e) => deactivateCategory(tx, "ministries", (e.data as { key: string }).key),
    "sector.upserted": termUpserted,
    "theme.upserted": termUpserted,
    "tag.upserted": termUpserted,
    "sector.deactivated": termDeactivated,
    "theme.deactivated": termDeactivated,
    "tag.deactivated": termDeactivated,
    "release.published": (tx, e) => applyRelease(tx, e.data as ReleaseRecord),
    "release.updated": (tx, e) => applyRelease(tx, e.data as ReleaseRecord),
    "release.unpublished": (tx, e) => unpublishRelease(tx, (e.data as { key: string }).key),
    "site.content.changed": (tx, e) => applySiteContent(tx, e.data as SiteContentChanged),
  };
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run apps/news-api && npm run check`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/news-api
git commit -m "feat(news-api): event projections with transactional update notifications"
```

---

### Task 5: DTO serializers

**Files:**
- Create: `apps/news-api/src/dto.ts`
- Test: `apps/news-api/src/dto.test.ts`

**Interfaces:**
- Consumes: row types (Task 3), `formatOffsetDateTime`.
- Produces (each returns the exact legacy JSON shape, keys in live order):
  - `toPostDto(p: PostRow, tz: string)`
  - `toKeyValue(p: Pick<PostRow, "key" | "kind">): { key: string; value: string }`
  - `toMinistryDto(c: CategoryRow, f: FeatureRow | undefined, childKey: string | null, tz: string)`
  - `toMinisterDto(c: CategoryRow, tz: string)`
  - `ministerEmailHtml(email: string | null): string | null` → `<a href="mailto: X">X</a>`; `""` → `""`; `null` → `null`
  - `toCategoryDto(c: CategoryRow, f: FeatureRow | undefined, tz: string)` (sectors/themes/tags)
  - `toHomeDto(h: HomeRow | undefined, tz: string)` — when no row: all-null home with `timestamp` = epoch
  - `toSlideDto(s: SlideRow, tz: string)`, `toResourceLinkDto(l: ResourceLinkRow, tz: string)`

- [ ] **Step 1: Write the failing test**

`apps/news-api/src/dto.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { CategoryRow, PostRow } from "./db/schema";
import { ministerEmailHtml, toCategoryDto, toMinisterDto, toMinistryDto, toPostDto, toSlideDto } from "./dto";

const tz = "America/Vancouver";

const post: PostRow = {
  key: "2026TT0103-001121", kind: "releases", reference: "NEWS-34336", atomId: "uuid:9af8cc16-0ae5-4ec6-ad58-fdb081d44e37",
  publishDate: new Date("2026-10-01T22:10:00Z"), leadMinistryKey: "transportation-and-transit", summary: "s", socialMediaSummary: null,
  socialMediaHeadline: null, keywords: "", location: "Abbotsford", hasMediaAssets: false, hasTranslations: false, isNewsOnDemand: true,
  assetUrl: "", redirectUri: null, documents: [], ministryKeys: ["transportation-and-transit"], sectorKeys: [], tagKeys: [], themeKeys: [],
  indexKeys: [], assets: null, translations: null, isPublished: true, timestamp: new Date("2026-10-01T22:10:28.037Z"),
};

const ministry: CategoryRow = {
  kind: "ministries", key: "health", name: "Health", sortOrder: 0, isActive: true,
  social: { twitterUsername: "", flickrUrl: "https://flickr", youtubeUrl: null, audioUrl: null },
  ministry: {
    parentKey: null, url: "http://gov.bc.ca/health", displayAdditionalName: null,
    minister: { name: "Honourable Ravi Kahlon", summary: "Honourable Ravi Kahlon", detailsHtml: "<p>bio</p>", email: "HLTH.Minister@gov.bc.ca", photoUrl: "https://photo", address: "PO BOX 9050" },
    contact: { fullName: "Alex Example", phoneNumber: "1", mobileNumber: "2", emailAddress: "k@gov.bc.ca" }, secondContact: null,
    weekendContactNumber: "", topicLinks: [{ text: "Get immunized", url: "https://x" }], serviceLinks: [],
  },
  timestamp: new Date("2026-10-02T23:46:05.527Z"),
};

describe("dto", () => {
  it("serializes a post with legacy field names and key order", () => {
    const dto = toPostDto(post, tz);
    expect(Object.keys(dto)).toEqual([
      "kind", "atomId", "summary", "socialMediaSummary", "socialMediaHeadline", "keywords", "publishDate", "leadMinistryKey", "hasMediaAssets",
      "hasTranslations", "isNewsOnDemand", "assetUrl", "location", "documents", "reference", "redirectUri", "ministryKeys", "sectorKeys",
      "tagKeys", "themeKeys", "azureAssets", "azureTranslations", "key", "timestamp",
    ]);
    expect(dto.publishDate).toBe("2026-10-01T15:10:00-07:00");
    expect(dto.timestamp).toBe("2026-10-01T15:10:28.037-07:00");
    expect(dto).not.toHaveProperty("memoryCachable");
  });

  it("serializes a ministry with features, child key, links and empty newsletterLinks", () => {
    const dto = toMinistryDto(ministry, { kind: "ministries", key: "health", topPostKey: "t", featurePostKey: "f" }, "child", tz);
    expect(dto).toMatchObject({
      childMinistryKey: "child", parentMinistryKey: null, ministryUrl: "http://gov.bc.ca/health", newsletterLinks: [],
      ministerName: "Honourable Ravi Kahlon", contactUser: { fullName: "Alex Example" }, flickrUri: "https://flickr", kind: "ministries",
      name: "Health", topPostKey: "t", featurePostKey: "f", key: "health",
    });
    expect(dto.topicLinks).toEqual([{ uri: "https://x", key: "Get immunized", timestamp: "2026-10-02T16:46:05.527-07:00" }]);
  });

  it("serializes the minister", () => {
    expect(toMinisterDto(ministry, tz)).toEqual({
      headline: "Honourable Ravi Kahlon", summary: "Honourable Ravi Kahlon", details: "<p>bio</p>",
      emailHtml: '<a href="mailto: HLTH.Minister@gov.bc.ca">HLTH.Minister@gov.bc.ca</a>', photo: "https://photo", post: "PO BOX 9050",
      key: "health", timestamp: "2026-10-02T16:46:05.527-07:00",
    });
    expect(ministerEmailHtml("")).toBe("");
    expect(ministerEmailHtml(null)).toBeNull();
  });

  it("serializes a term category without features as null keys", () => {
    const dto = toCategoryDto({ ...ministry, kind: "sectors", key: "economy", name: "Economy", ministry: null }, undefined, tz);
    expect(dto).toEqual({
      twitterFeedUsername: "", flickrUri: "https://flickr", youtubeUri: null, audioUri: null, isActive: true, kind: "sectors", name: "Economy",
      topPostKey: null, featurePostKey: null, key: "economy", timestamp: "2026-10-02T16:46:05.527-07:00",
    });
  });

  it("serializes a slide image as base64 and key as the id", () => {
    const dto = toSlideDto(
      { id: "f9adfdc2-5933-4c38-a390-a18077acb213", sortIndex: 0, headline: "h", summary: "s", actionLabel: "READ MORE", actionUri: "u", image: Buffer.from("iVBORw0KGgo=", "base64"), imageType: "image/png", facebookPostUri: null, justify: "right", timestamp: new Date("2026-09-09T23:31:07.521Z") },
      tz,
    );
    expect(dto.image).toBe("iVBORw0KGgo=");
    expect(dto.key).toBe("f9adfdc2-5933-4c38-a390-a18077acb213");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/news-api/src/dto.test.ts`
Expected: FAIL — cannot resolve `./dto`.

- [ ] **Step 3: Implement**

`apps/news-api/src/dto.ts`:
```ts
import type { CategoryRow, FeatureRow, HomeRow, PostRow, ResourceLinkRow, SlideRow } from "./db/schema";
import { formatOffsetDateTime } from "./time";

export function toPostDto(p: PostRow, tz: string) {
  return {
    kind: p.kind,
    atomId: p.atomId,
    summary: p.summary,
    socialMediaSummary: p.socialMediaSummary,
    socialMediaHeadline: p.socialMediaHeadline,
    keywords: p.keywords,
    publishDate: formatOffsetDateTime(p.publishDate, tz),
    leadMinistryKey: p.leadMinistryKey,
    hasMediaAssets: p.hasMediaAssets,
    hasTranslations: p.hasTranslations,
    isNewsOnDemand: p.isNewsOnDemand,
    assetUrl: p.assetUrl,
    location: p.location,
    documents: p.documents,
    reference: p.reference,
    redirectUri: p.redirectUri,
    ministryKeys: p.ministryKeys,
    sectorKeys: p.sectorKeys,
    tagKeys: p.tagKeys,
    themeKeys: p.themeKeys,
    azureAssets: p.assets,
    azureTranslations: p.translations,
    key: p.key,
    timestamp: formatOffsetDateTime(p.timestamp, tz),
  };
}

export function toKeyValue(p: Pick<PostRow, "key" | "kind">): { key: string; value: string } {
  return { key: p.key, value: p.kind };
}

export function toMinistryDto(c: CategoryRow, f: FeatureRow | undefined, childKey: string | null, tz: string) {
  const m = c.ministry!;
  const ts = formatOffsetDateTime(c.timestamp, tz);
  const link = (l: { text: string; url: string }) => ({ uri: l.url, key: l.text, timestamp: ts });
  return {
    childMinistryKey: childKey,
    parentMinistryKey: m.parentKey,
    ministryUrl: m.url,
    displayAdditionalName: m.displayAdditionalName,
    topicLinks: m.topicLinks.map(link),
    serviceLinks: m.serviceLinks.map(link),
    newsletterLinks: [] as never[],
    ministerName: m.minister.name,
    contactUser: m.contact,
    secondContactUser: m.secondContact,
    weekendContactNumber: m.weekendContactNumber,
    twitterFeedUsername: c.social.twitterUsername,
    flickrUri: c.social.flickrUrl,
    youtubeUri: c.social.youtubeUrl,
    audioUri: c.social.audioUrl,
    isActive: c.isActive,
    kind: "ministries",
    name: c.name,
    topPostKey: f?.topPostKey ?? null,
    featurePostKey: f?.featurePostKey ?? null,
    key: c.key,
    timestamp: ts,
  };
}

export function ministerEmailHtml(email: string | null): string | null {
  if (email === null) return null;
  if (email === "") return "";
  return `<a href="mailto: ${email}">${email}</a>`;
}

export function toMinisterDto(c: CategoryRow, tz: string) {
  const m = c.ministry!.minister;
  return {
    headline: m.name,
    summary: m.summary,
    details: m.detailsHtml,
    emailHtml: ministerEmailHtml(m.email),
    photo: m.photoUrl,
    post: m.address,
    key: c.key,
    timestamp: formatOffsetDateTime(c.timestamp, tz),
  };
}

export function toCategoryDto(c: CategoryRow, f: FeatureRow | undefined, tz: string) {
  return {
    twitterFeedUsername: c.social.twitterUsername,
    flickrUri: c.social.flickrUrl,
    youtubeUri: c.social.youtubeUrl,
    audioUri: c.social.audioUrl,
    isActive: c.isActive,
    kind: c.kind,
    name: c.name,
    topPostKey: f?.topPostKey ?? null,
    featurePostKey: f?.featurePostKey ?? null,
    key: c.key,
    timestamp: formatOffsetDateTime(c.timestamp, tz),
  };
}

export function toHomeDto(h: HomeRow | undefined, tz: string) {
  return {
    liveWebcastFlashMediaManifestUrl: h?.liveWebcastFlashMediaManifestUrl ?? null,
    liveWebcastM3uPlaylist: h?.liveWebcastM3uPlaylist ?? null,
    granville: h?.granville ?? null,
    kind: "home",
    name: null,
    topPostKey: h?.topPostKey ?? null,
    featurePostKey: h?.featurePostKey ?? null,
    key: "default",
    timestamp: formatOffsetDateTime(h?.timestamp ?? new Date(0), tz),
  };
}

export function toSlideDto(s: SlideRow, tz: string) {
  return {
    headline: s.headline,
    summary: s.summary,
    actionLabel: s.actionLabel,
    actionUri: s.actionUri,
    image: s.image ? s.image.toString("base64") : null,
    facebookPostUri: s.facebookPostUri,
    justify: s.justify,
    imageType: s.imageType,
    key: s.id,
    timestamp: formatOffsetDateTime(s.timestamp, tz),
  };
}

export function toResourceLinkDto(l: ResourceLinkRow, tz: string) {
  return { uri: l.uri, key: l.text, timestamp: formatOffsetDateTime(l.timestamp, tz) };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run apps/news-api/src/dto.test.ts && npm run check`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/news-api
git commit -m "feat(news-api): legacy-shaped DTO serializers"
```

---

### Task 6: Read queries, errors middleware, category and site endpoints

**Files:**
- Create: `apps/news-api/src/read.ts`, `apps/news-api/src/http/errors.ts`, `apps/news-api/src/http/v1/categories.ts`, `apps/news-api/src/http/v1/site.ts`, `apps/news-api/src/app.ts`
- Test: `apps/news-api/src/http/v1/categories.test.ts`

**Interfaces:**
- Consumes: DTOs (Task 5), projections (Task 4), `createEventReceiver` (Phase 0).
- Produces:
  - `requireApiVersion(): RequestHandler`, `emptyOk(res)`, `problemNotFound(res)`
  - Read functions (`read.ts`): `listMinistries(db, tz)`, `getMinistry(db, key, tz)`, `getMinister(db, key, tz)`, `listCategories(db, kind, tz)`, `getCategory(db, kind, key, tz)`, `getHome(db, tz)`, `listSlides(db, tz)`, `getSlide(db, id, tz)`, `listResourceLinks(db, tz)`, `findCategoryKey(db, kind, key): Promise<string | null>`, `getFeatures(db, kind, key): Promise<FeatureRow | undefined>`
  - `interface AppDeps { db: Db; timeZone: string; eventSecrets: Record<string, string>; subscribe?: SubscribeProxyOptions; hubRouter?: express.Router }`
  - `createApp(deps: AppDeps): express.Express` — mounts `/health/live`, `/health/ready`, `POST /events` (receiver with `createProjectionHandlers()`), optional hub router, and `/api` (api-version check, `Cache-Control: no-cache`, v1 routers)
  - `categoryRoutes(db, tz): Router` — `GET /Ministries`, `/Ministries/:key`, `/Ministries/:key/Minister`, `/Sectors`, `/Sectors/:key`, `/Themes`, `/Themes/:key`, `/Tags`, `/Tags/:key`
  - `siteRoutes(db, tz): Router` — `GET /Home`, `/Slides`, `/Slides/:id`, `/ResourceLinks`
  - (Task 10 adds `SubscribeProxyOptions`; until then declare it in `app.ts` as `export interface SubscribeProxyOptions { baseUrl: string; getToken?: () => Promise<string>; rateLimitPerMinute: number }` and leave it unused.)

- [ ] **Step 1: Write the failing test**

`apps/news-api/src/http/v1/categories.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { OrgRecord } from "@gcpe/events";
import { createApp } from "../../app";
import { createNewsTestDb, envelope, EVENT_SECRETS, sendEvent, TZ } from "../../../test/helpers";

const base: Omit<OrgRecord, "key" | "displayName" | "parentKey" | "isActive" | "sortOrder"> = {
  abbreviation: null, url: null, displayAdditionalName: null,
  minister: { name: "Hon. X", summary: "Hon. X", detailsHtml: "", email: "", photoUrl: null, address: null },
  contact: null, secondContact: null, weekendContactNumber: "", social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null },
  topicLinks: [], serviceLinks: [], sectorKeys: [], updatedAt: "2026-10-02T16:46:05.527-07:00",
};
const org = (key: string, sortOrder: number, parentKey: string | null, isActive = true): OrgRecord => ({ ...base, key, displayName: key, sortOrder, parentKey, isActive });

describe("category and site endpoints", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  const V = "api-version=1.0";

  beforeAll(async () => {
    tdb = await createNewsTestDb();
    app = createApp({ db: tdb.db, timeZone: TZ, eventSecrets: EVENT_SECRETS });
    for (const o of [org("forests", 1, null), org("sustainable-forestry-innovation", 2, "forests", false), org("premier", 0, null), org("local-gov", 3, "premier")]) {
      await sendEvent(app, envelope("core", "org.upserted", `org:${o.key}`, o));
    }
    await sendEvent(app, envelope("nrms", "site.content.changed", "site:feature:ministries:premier", { entity: "categoryFeatures", kind: "ministries", key: "premier", topPostKey: "T", featurePostKey: "F" }));
    await sendEvent(app, envelope("core", "sector.upserted", "sector:economy", { kind: "sector", key: "economy", displayName: "Economy", sortOrder: 0, isActive: true, social: base.social, updatedAt: base.updatedAt }));
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("400 without api-version, 400 for unsupported versions", async () => {
    const missing = await request(app).get("/api/Ministries");
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ error: { code: "ApiVersionUnspecified", message: "An API version is required, but was not specified.", innerError: null } });
    const bad = await request(app).get("/api/Ministries?api-version=2.0");
    expect(bad.body.error.code).toBe("UnsupportedApiVersion");
    expect((await request(app).get("/api/Ministries?api-version=1")).status).toBe(200);
  });

  it("lists ministries in sort order with active child keys only", async () => {
    const res = await request(app).get(`/api/Ministries?${V}`);
    expect(res.body.map((m: { key: string }) => m.key)).toEqual(["premier", "forests", "sustainable-forestry-innovation", "local-gov"]);
    const byKey = Object.fromEntries(res.body.map((m: { key: string }) => [m.key, m]));
    expect(byKey.premier.childMinistryKey).toBe("local-gov");
    expect(byKey.forests.childMinistryKey).toBeNull();
    expect(byKey.premier.topPostKey).toBe("T");
  });

  it("looks up ministries case-insensitively and returns empty 200 when missing", async () => {
    expect((await request(app).get(`/api/Ministries/PREMIER?${V}`)).body.key).toBe("premier");
    const missing = await request(app).get(`/api/Ministries/nope?${V}`);
    expect(missing.status).toBe(200);
    expect(missing.text).toBe("");
    expect((await request(app).get(`/api/ministries/premier/minister?${V}`)).body.headline).toBe("Hon. X");
  });

  it("serves sectors and an empty home", async () => {
    expect((await request(app).get(`/api/Sectors/ECONOMY?${V}`)).body.name).toBe("Economy");
    expect((await request(app).get(`/api/Sectors/zz?${V}`)).text).toBe("");
    const home = await request(app).get(`/api/Home?${V}`);
    expect(home.body).toMatchObject({ kind: "home", key: "default", topPostKey: null });
    expect(home.headers["cache-control"]).toBe("no-cache");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/news-api/src/http`
Expected: FAIL — cannot resolve `../../app`.

- [ ] **Step 3: Implement errors and read queries**

`apps/news-api/src/http/errors.ts`:
```ts
import { randomBytes } from "node:crypto";
import type { RequestHandler, Response } from "express";

export function emptyOk(res: Response): void {
  res.status(200).end();
}

export function problemNotFound(res: Response): void {
  res.status(404).json({
    type: "https://tools.ietf.org/html/rfc7231#section-6.5.4",
    title: "Not Found",
    status: 404,
    traceId: `|${randomBytes(4).toString("hex")}-${randomBytes(4).toString("hex")}.`,
  });
}

export function requireApiVersion(): RequestHandler {
  return (req, res, next) => {
    const raw = req.query["api-version"];
    const version = Array.isArray(raw) ? raw[0] : raw;
    if (version === undefined) {
      return void res.status(400).json({
        error: { code: "ApiVersionUnspecified", message: "An API version is required, but was not specified.", innerError: null },
      });
    }
    if (version !== "1.0" && version !== "1") {
      const uri = `${req.protocol}://${req.get("host")}${req.baseUrl}${req.path}`;
      return void res.status(400).json({
        error: {
          code: "UnsupportedApiVersion",
          message: `The HTTP resource that matches the request URI '${uri}' does not support the API version '${String(version)}'.`,
          innerError: null,
        },
      });
    }
    next();
  };
}
```

`apps/news-api/src/read.ts`:
```ts
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import type { CategoryKind } from "@gcpe/events";
import { categories, categoryFeatures, home, resourceLinks, slides, type CategoryRow, type FeatureRow } from "./db/schema";
import { toCategoryDto, toHomeDto, toMinisterDto, toMinistryDto, toResourceLinkDto, toSlideDto } from "./dto";

const lowerEq = (col: typeof categories.key, value: string) => sql`lower(${col}) = lower(${value})`;

async function featureMap(db: Db, kind: CategoryKind): Promise<Map<string, FeatureRow>> {
  const rows = await db.select().from(categoryFeatures).where(eq(categoryFeatures.kind, kind));
  return new Map(rows.map((r) => [r.key, r]));
}

export async function getFeatures(db: Db, kind: CategoryKind, key: string): Promise<FeatureRow | undefined> {
  const [row] = await db
    .select()
    .from(categoryFeatures)
    .where(and(eq(categoryFeatures.kind, kind), eq(categoryFeatures.key, key.toLowerCase())));
  return row;
}

export async function findCategoryKey(db: Db, kind: CategoryKind, key: string): Promise<string | null> {
  const [row] = await db
    .select({ key: categories.key })
    .from(categories)
    .where(and(eq(categories.kind, kind), lowerEq(categories.key, key)));
  return row?.key ?? null;
}

function activeChildKey(key: string, all: CategoryRow[]): string | null {
  const child = all.find((r) => r.isActive && r.ministry?.parentKey?.toLowerCase() === key.toLowerCase());
  return child?.key ?? null;
}

async function allMinistries(db: Db): Promise<CategoryRow[]> {
  return db.select().from(categories).where(eq(categories.kind, "ministries")).orderBy(asc(categories.sortOrder), asc(categories.key));
}

export async function listMinistries(db: Db, tz: string) {
  const rows = await allMinistries(db);
  const features = await featureMap(db, "ministries");
  return rows.map((r) => toMinistryDto(r, features.get(r.key.toLowerCase()), activeChildKey(r.key, rows), tz));
}

export async function getMinistry(db: Db, key: string, tz: string) {
  const rows = await allMinistries(db);
  const row = rows.find((r) => r.key.toLowerCase() === key.toLowerCase());
  if (!row) return null;
  return toMinistryDto(row, await getFeatures(db, "ministries", row.key), activeChildKey(row.key, rows), tz);
}

export async function getMinister(db: Db, key: string, tz: string) {
  const [row] = await db.select().from(categories).where(and(eq(categories.kind, "ministries"), lowerEq(categories.key, key)));
  return row ? toMinisterDto(row, tz) : null;
}

export async function listCategories(db: Db, kind: Exclude<CategoryKind, "ministries">, tz: string) {
  const rows = await db.select().from(categories).where(eq(categories.kind, kind)).orderBy(asc(categories.sortOrder), asc(categories.key));
  const features = await featureMap(db, kind);
  return rows.map((r) => toCategoryDto(r, features.get(r.key.toLowerCase()), tz));
}

export async function getCategory(db: Db, kind: Exclude<CategoryKind, "ministries">, key: string, tz: string) {
  const [row] = await db.select().from(categories).where(and(eq(categories.kind, kind), lowerEq(categories.key, key)));
  return row ? toCategoryDto(row, await getFeatures(db, kind, row.key), tz) : null;
}

export async function getHome(db: Db, tz: string) {
  const [row] = await db.select().from(home).where(eq(home.key, "default"));
  return toHomeDto(row, tz);
}

export async function listSlides(db: Db, tz: string) {
  return (await db.select().from(slides).orderBy(asc(slides.sortIndex))).map((s) => toSlideDto(s, tz));
}

export async function getSlide(db: Db, id: string, tz: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db.select().from(slides).where(eq(slides.id, id.toLowerCase()));
  return row ? toSlideDto(row, tz) : null;
}

export async function listResourceLinks(db: Db, tz: string) {
  return (await db.select().from(resourceLinks).orderBy(asc(resourceLinks.sortIndex))).map((l) => toResourceLinkDto(l, tz));
}
```

- [ ] **Step 4: Implement routers and app**

`apps/news-api/src/http/v1/categories.ts`:
```ts
import { Router } from "express";
import type { Db } from "@gcpe/db-kit";
import { getCategory, getMinister, getMinistry, listCategories, listMinistries } from "../../read";
import { emptyOk } from "../errors";

export function categoryRoutes(db: Db, tz: string): Router {
  const r = Router();
  r.get("/Ministries", async (_req, res) => void res.json(await listMinistries(db, tz)));
  r.get("/Ministries/:key", async (req, res) => {
    const dto = await getMinistry(db, req.params.key, tz);
    dto ? res.json(dto) : emptyOk(res);
  });
  r.get("/Ministries/:key/Minister", async (req, res) => {
    const dto = await getMinister(db, req.params.key, tz);
    dto ? res.json(dto) : emptyOk(res);
  });
  for (const [path, kind] of [["Sectors", "sectors"], ["Themes", "themes"], ["Tags", "tags"]] as const) {
    r.get(`/${path}`, async (_req, res) => void res.json(await listCategories(db, kind, tz)));
    r.get(`/${path}/:key`, async (req, res) => {
      const dto = await getCategory(db, kind, req.params.key, tz);
      dto ? res.json(dto) : emptyOk(res);
    });
  }
  return r;
}
```

`apps/news-api/src/http/v1/site.ts`:
```ts
import { Router } from "express";
import type { Db } from "@gcpe/db-kit";
import { getHome, getSlide, listResourceLinks, listSlides } from "../../read";
import { emptyOk } from "../errors";

export function siteRoutes(db: Db, tz: string): Router {
  const r = Router();
  r.get("/Home", async (_req, res) => void res.json(await getHome(db, tz)));
  r.get("/Slides", async (_req, res) => void res.json(await listSlides(db, tz)));
  r.get("/Slides/:id", async (req, res) => {
    const dto = await getSlide(db, req.params.id, tz);
    dto ? res.json(dto) : emptyOk(res);
  });
  r.get("/ResourceLinks", async (_req, res) => void res.json(await listResourceLinks(db, tz)));
  return r;
}
```

`apps/news-api/src/app.ts`:
```ts
import express from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { createEventReceiver } from "@gcpe/events";
import { requireApiVersion } from "./http/errors";
import { categoryRoutes } from "./http/v1/categories";
import { siteRoutes } from "./http/v1/site";
import { createProjectionHandlers } from "./projections";

export interface SubscribeProxyOptions {
  baseUrl: string;
  getToken?: () => Promise<string>;
  rateLimitPerMinute: number;
}

export interface AppDeps {
  db: Db;
  timeZone: string;
  eventSecrets: Record<string, string>;
  subscribe?: SubscribeProxyOptions;
  hubRouter?: express.Router;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // one hop: the OpenShift router

  app.get("/health/live", (_req, res) => void res.json({ status: "ok" }));
  app.get("/health/ready", async (_req, res) => {
    try {
      await deps.db.execute(sql`SELECT 1`);
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });

  app.use(createEventReceiver({ db: deps.db, secrets: deps.eventSecrets, handlers: createProjectionHandlers() }));
  if (deps.hubRouter) app.use(deps.hubRouter);

  const api = express.Router();
  api.use(requireApiVersion());
  api.use((_req, res, next) => {
    res.set("Cache-Control", "no-cache");
    next();
  });
  api.use(categoryRoutes(deps.db, deps.timeZone));
  api.use(siteRoutes(deps.db, deps.timeZone));
  app.use("/api", api);
  return app;
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run apps/news-api && npm run check`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/news-api
git commit -m "feat(news-api): api-version contract, category and site endpoints"
```

---

### Task 7: Posts endpoints

**Files:**
- Create: `apps/news-api/src/posts.ts`, `apps/news-api/src/http/v1/posts.ts`
- Modify: `apps/news-api/src/app.ts` (mount `postRoutes`)
- Test: `apps/news-api/src/http/v1/posts.test.ts`

**Interfaces:**
- Consumes: `posts`, `home`, `findCategoryKey`, `getFeatures`, `toPostDto`, `toKeyValue`.
- Produces:
  - `INDEX_KINDS = ["home", "ministries", "sectors", "tags", "themes"] as const`
  - `type ResolvedIndex = { kind: (typeof INDEX_KINDS)[number]; key: string; topPostKey: string | null; featurePostKey: string | null }`
  - `resolveIndex(db, kind: string, key: string): Promise<ResolvedIndex | "unknown-kind" | "not-found">`
  - `latestPosts(db, idx: ResolvedIndex, opts: PostQueryOptions): Promise<PostRow[]>` (excludes top/feature)
  - `postKeys(db, idx: ResolvedIndex, opts: PostQueryOptions): Promise<{ key: string; kind: string }[]>` (does not exclude)
  - `interface PostQueryOptions { postKind?: string; count?: number; skip?: number }`
  - `getPost(db, key)`, `getPostsByKeys(db, keys: string[])` (request order, unknown skipped), `getPostByReference(db, reference)`, `latestMediaUri(db, mediaType)` — all published-only
  - `MEDIA_TYPE_PATTERNS: Record<string, RegExp>` — `video: /youtube\.com|youtu\.be/i`, `image: /flickr\.com|flic\.kr/i` (assumption; live returned 204 for `video`)
  - `postRoutes(db, tz): Router` — `GET /Posts`, `/Posts/:key`, `/Posts/Latest/:indexKind/:indexKey`, `/Posts/Keys/:indexKind/:indexKey`, `/Posts/Keys/:reference`, `/Posts/LatestMediaUri/:mediaType`

- [ ] **Step 1: Write the failing test**

`apps/news-api/src/http/v1/posts.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { ReleaseRecord } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { createApp } from "../../app";
import { createNewsTestDb, envelope, EVENT_SECRETS, sendEvent, TZ } from "../../../test/helpers";

const V = "api-version=1.0";
const rel = (key: string, publishDate: string, extra: Partial<ReleaseRecord> = {}): ReleaseRecord => ({
  ...sampleRelease, key, reference: `NEWS-${key}`, publishDate, ministryKeys: ["health"], sectorKeys: [], ...extra,
});

describe("posts endpoints", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    tdb = await createNewsTestDb();
    app = createApp({ db: tdb.db, timeZone: TZ, eventSecrets: EVENT_SECRETS });
    await sendEvent(app, envelope("core", "org.upserted", "org:health", {
      key: "health", displayName: "Health", abbreviation: null, sortOrder: 0, isActive: true, parentKey: null, url: null, displayAdditionalName: null,
      minister: { name: null, summary: null, detailsHtml: null, email: null, photoUrl: null, address: null }, contact: null, secondContact: null,
      weekendContactNumber: null, social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null }, topicLinks: [], serviceLinks: [],
      sectorKeys: [], updatedAt: "2026-10-01T00:00:00Z",
    }));
    const releases = [
      rel("R1", "2026-10-01T10:00:00-07:00"),
      rel("R2", "2026-10-02T10:00:00-07:00"),
      rel("R3", "2026-10-03T10:00:00-07:00"),
      rel("S1", "2026-10-04T10:00:00-07:00", { kind: "stories" }),
      rel("F1", "2026-10-05T10:00:00-07:00", { kind: "factsheets" }),
      rel("Y1", "2026-09-01T10:00:00-07:00", { assetUrl: "https://www.youtube.com/watch?v=abc", hasMediaAssets: true }),
      rel("GONE", "2026-10-06T10:00:00-07:00"),
    ];
    for (const r of releases) await sendEvent(app, envelope("nrms", "release.published", `release:${r.key}`, r));
    await sendEvent(app, envelope("nrms", "release.unpublished", "release:GONE", { key: "GONE" }));
    await sendEvent(app, envelope("nrms", "site.content.changed", "site:home", { entity: "home", topPostKey: "S1", featurePostKey: "R3", liveWebcastFlashMediaManifestUrl: null, liveWebcastM3uPlaylist: null, granville: null, timestamp: "2026-10-01T00:00:00Z" }));
    await sendEvent(app, envelope("nrms", "site.content.changed", "site:feature:ministries:health", { entity: "categoryFeatures", kind: "ministries", key: "health", topPostKey: "R2", featurePostKey: null }));
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const keys = (body: { key: string }[]) => body.map((p) => p.key);

  it("Latest excludes the index's top and feature posts; Keys does not", async () => {
    expect(keys((await request(app).get(`/api/Posts/Latest/home/default?${V}`)).body)).toEqual(["R2", "R1", "Y1"]);
    expect(keys((await request(app).get(`/api/Posts/Keys/home/default?${V}`)).body)).toEqual(["S1", "R3", "R2", "R1", "Y1"]);
    expect(keys((await request(app).get(`/api/Posts/Latest/ministries/health?${V}`)).body)).toEqual(["S1", "R3", "R1", "Y1"]);
  });

  it("Latest without count returns all posts, ordered; count and skip page", async () => {
    expect(keys((await request(app).get(`/api/Posts/Keys/home/default?count=2&skip=1&${V}`)).body)).toEqual(["R3", "R2"]);
  });

  it("filters by postKind and returns key/value pairs", async () => {
    expect((await request(app).get(`/api/Posts/Keys/home/default?postKind=factsheets&${V}`)).body).toEqual([{ key: "F1", value: "factsheets" }]);
    expect((await request(app).get(`/api/Posts/Keys/home/default?postKind=advisories&${V}`)).body).toEqual([]);
  });

  it("index lookups: case-insensitive key, 404 problem for unknown key, empty 200 for unknown kind", async () => {
    expect(keys((await request(app).get(`/api/Posts/Keys/ministries/HEALTH?count=1&${V}`)).body)).toEqual(["S1"]);
    const nf = await request(app).get(`/api/Posts/Keys/ministries/zz?${V}`);
    expect(nf.status).toBe(404);
    expect(nf.body).toMatchObject({ title: "Not Found", status: 404 });
    const uk = await request(app).get(`/api/Posts/Keys/services/zz?${V}`);
    expect([uk.status, uk.text]).toEqual([200, ""]);
    expect((await request(app).get(`/api/Posts/Keys/home/other?${V}`)).status).toBe(404);
  });

  it("single post: case-insensitive, empty 200 when missing", async () => {
    expect((await request(app).get(`/api/Posts/r1?${V}`)).body.key).toBe("R1");
    expect((await request(app).get(`/api/Posts/zz?${V}`)).text).toBe("");
  });

  it("postKeys is comma-separated, in request order, unknown skipped, first repeated param only", async () => {
    expect(keys((await request(app).get(`/api/Posts?postKeys=r3,zz,R1&${V}`)).body)).toEqual(["R3", "R1"]);
    expect(keys((await request(app).get(`/api/Posts?postKeys=R2&postKeys=R1&${V}`)).body)).toEqual(["R2"]);
    expect((await request(app).get(`/api/Posts?${V}`)).body).toEqual([]);
  });

  it("Keys/{reference} is case-insensitive and returns one pair", async () => {
    expect((await request(app).get(`/api/Posts/Keys/news-r2?${V}`)).body).toEqual({ key: "R2", value: "releases" });
    expect((await request(app).get(`/api/Posts/Keys/NEWS-zz?${V}`)).text).toBe("");
  });

  it("LatestMediaUri returns the newest matching asset URL, 204 otherwise", async () => {
    expect((await request(app).get(`/api/Posts/LatestMediaUri/video?${V}`)).body).toBe("https://www.youtube.com/watch?v=abc");
    expect((await request(app).get(`/api/Posts/LatestMediaUri/image?${V}`)).status).toBe(204);
    expect((await request(app).get(`/api/Posts/LatestMediaUri/podcast?${V}`)).status).toBe(204);
  });

  it("unpublished post is invisible everywhere", async () => {
    expect((await request(app).get(`/api/Posts/GONE?${V}`)).text).toBe("");
    expect((await request(app).get(`/api/Posts/Keys/NEWS-GONE?${V}`)).text).toBe("");
    expect((await request(app).get(`/api/Posts?postKeys=GONE&${V}`)).body).toEqual([]);
    expect(keys((await request(app).get(`/api/Posts/Keys/home/default?${V}`)).body)).not.toContain("GONE");
  });

  it("400 for non-integer count", async () => {
    expect((await request(app).get(`/api/Posts/Keys/home/default?count=abc&${V}`)).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/news-api/src/http/v1/posts.test.ts`
Expected: FAIL — `/api/Posts...` routes return 404.

- [ ] **Step 3: Implement post queries**

`apps/news-api/src/posts.ts`:
```ts
import { and, arrayContains, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { home, posts, type PostRow } from "./db/schema";
import { findCategoryKey, getFeatures } from "./read";

export const INDEX_KINDS = ["home", "ministries", "sectors", "tags", "themes"] as const;
type IndexKind = (typeof INDEX_KINDS)[number];

export interface ResolvedIndex {
  kind: IndexKind;
  key: string;
  topPostKey: string | null;
  featurePostKey: string | null;
}

export interface PostQueryOptions {
  postKind?: string;
  count?: number;
  skip?: number;
}

export const MEDIA_TYPE_PATTERNS: Record<string, RegExp> = {
  video: /youtube\.com|youtu\.be/i,
  image: /flickr\.com|flic\.kr/i,
};

export async function resolveIndex(db: Db, kind: string, key: string): Promise<ResolvedIndex | "unknown-kind" | "not-found"> {
  const k = kind.toLowerCase() as IndexKind;
  if (!INDEX_KINDS.includes(k)) return "unknown-kind";
  if (k === "home") {
    if (key.toLowerCase() !== "default") return "not-found";
    const [h] = await db.select().from(home).where(eq(home.key, "default"));
    return { kind: k, key: "default", topPostKey: h?.topPostKey ?? null, featurePostKey: h?.featurePostKey ?? null };
  }
  const canonical = await findCategoryKey(db, k, key);
  if (!canonical) return "not-found";
  const f = await getFeatures(db, k, canonical);
  return { kind: k, key: canonical, topPostKey: f?.topPostKey ?? null, featurePostKey: f?.featurePostKey ?? null };
}

function conditions(idx: ResolvedIndex, opts: PostQueryOptions, excludeFeatured: boolean): SQL {
  const conds: SQL[] = [eq(posts.isPublished, true)];
  conds.push(!opts.postKind || opts.postKind.toLowerCase() === "default" ? inArray(posts.kind, ["releases", "stories"]) : eq(posts.kind, opts.postKind.toLowerCase()));
  if (idx.kind !== "home") conds.push(arrayContains(posts.indexKeys, [`${idx.kind}:${idx.key}`.toLowerCase()]));
  if (excludeFeatured) {
    const excluded = [idx.topPostKey, idx.featurePostKey].filter((k): k is string => !!k).map((k) => k.toLowerCase());
    if (excluded.length) conds.push(sql`lower(${posts.key}) NOT IN (${sql.join(excluded.map((e) => sql`${e}`), sql`, `)})`);
  }
  return and(...conds)!;
}

export async function latestPosts(db: Db, idx: ResolvedIndex, opts: PostQueryOptions): Promise<PostRow[]> {
  let q = db.select().from(posts).where(conditions(idx, opts, true)).orderBy(desc(posts.publishDate), desc(posts.key)).$dynamic();
  if (opts.count !== undefined) q = q.limit(opts.count);
  if (opts.skip) q = q.offset(opts.skip);
  return q;
}

export async function postKeys(db: Db, idx: ResolvedIndex, opts: PostQueryOptions): Promise<{ key: string; kind: string }[]> {
  let q = db
    .select({ key: posts.key, kind: posts.kind })
    .from(posts)
    .where(conditions(idx, opts, false))
    .orderBy(desc(posts.publishDate), desc(posts.key))
    .$dynamic();
  if (opts.count !== undefined) q = q.limit(opts.count);
  if (opts.skip) q = q.offset(opts.skip);
  return q;
}

export async function getPost(db: Db, key: string): Promise<PostRow | undefined> {
  const [row] = await db.select().from(posts).where(and(eq(posts.isPublished, true), sql`lower(${posts.key}) = lower(${key})`));
  return row;
}

export async function getPostsByKeys(db: Db, keys: string[]): Promise<PostRow[]> {
  if (keys.length === 0) return [];
  const lowered = keys.map((k) => k.toLowerCase());
  const rows = await db
    .select()
    .from(posts)
    .where(and(eq(posts.isPublished, true), inArray(sql`lower(${posts.key})`, lowered)));
  const byKey = new Map(rows.map((r) => [r.key.toLowerCase(), r]));
  return lowered.map((k) => byKey.get(k)).filter((r): r is PostRow => r !== undefined);
}

export async function getPostByReference(db: Db, reference: string): Promise<{ key: string; kind: string } | undefined> {
  const [row] = await db
    .select({ key: posts.key, kind: posts.kind })
    .from(posts)
    .where(and(eq(posts.isPublished, true), sql`lower(${posts.reference}) = lower(${reference})`));
  return row;
}

export async function latestMediaUri(db: Db, mediaType: string): Promise<string | null> {
  const pattern = MEDIA_TYPE_PATTERNS[mediaType.toLowerCase()];
  if (!pattern) return null;
  const rows = await db
    .select({ assetUrl: posts.assetUrl })
    .from(posts)
    .where(and(eq(posts.isPublished, true), eq(posts.hasMediaAssets, true), sql`${posts.assetUrl} ~* ${pattern.source}`))
    .orderBy(desc(posts.publishDate))
    .limit(1);
  return rows[0]?.assetUrl ?? null;
}
```

- [ ] **Step 4: Implement the router and mount it**

`apps/news-api/src/http/v1/posts.ts`:
```ts
import { Router, type Request, type Response } from "express";
import type { Db } from "@gcpe/db-kit";
import { toKeyValue, toPostDto } from "../../dto";
import { getPost, getPostByReference, getPostsByKeys, latestMediaUri, latestPosts, postKeys, resolveIndex, type PostQueryOptions } from "../../posts";
import { emptyOk, problemNotFound } from "../errors";

function first(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" ? v : undefined;
}

function parseOptions(req: Request, res: Response): PostQueryOptions | null {
  const opts: PostQueryOptions = { postKind: first(req.query.postKind) };
  for (const name of ["count", "skip"] as const) {
    const raw = first(req.query[name]);
    if (raw === undefined || raw === "") continue;
    if (!/^\d+$/.test(raw)) {
      res.status(400).json({ errors: { [name]: [`The value '${raw}' is not valid.`] }, title: "One or more validation errors occurred.", status: 400 });
      return null;
    }
    opts[name] = Number(raw);
  }
  return opts;
}

export function postRoutes(db: Db, tz: string): Router {
  const r = Router();

  r.get("/Posts", async (req, res) => {
    const csv = first(req.query.postKeys) ?? "";
    const keys = csv.split(",").map((k) => k.trim()).filter(Boolean);
    res.json((await getPostsByKeys(db, keys)).map((p) => toPostDto(p, tz)));
  });

  r.get("/Posts/Latest/:indexKind/:indexKey", async (req, res) => {
    const opts = parseOptions(req, res);
    if (!opts) return;
    const idx = await resolveIndex(db, req.params.indexKind, req.params.indexKey);
    if (idx === "unknown-kind") return emptyOk(res);
    if (idx === "not-found") return problemNotFound(res);
    res.json((await latestPosts(db, idx, opts)).map((p) => toPostDto(p, tz)));
  });

  r.get("/Posts/Keys/:indexKind/:indexKey", async (req, res) => {
    const opts = parseOptions(req, res);
    if (!opts) return;
    const idx = await resolveIndex(db, req.params.indexKind, req.params.indexKey);
    if (idx === "unknown-kind") return emptyOk(res);
    if (idx === "not-found") return problemNotFound(res);
    res.json((await postKeys(db, idx, opts)).map(toKeyValue));
  });

  r.get("/Posts/Keys/:reference", async (req, res) => {
    const row = await getPostByReference(db, req.params.reference);
    row ? res.json(toKeyValue(row)) : emptyOk(res);
  });

  r.get("/Posts/LatestMediaUri/:mediaType", async (req, res) => {
    const uri = await latestMediaUri(db, req.params.mediaType);
    uri ? res.json(uri) : res.status(204).end();
  });

  r.get("/Posts/:key", async (req, res) => {
    const row = await getPost(db, req.params.key);
    row ? res.json(toPostDto(row, tz)) : emptyOk(res);
  });

  return r;
}
```

In `apps/news-api/src/app.ts`, add `import { postRoutes } from "./http/v1/posts";` and after `api.use(siteRoutes(...))` add:
```ts
  api.use(postRoutes(deps.db, deps.timeZone));
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run apps/news-api && npm run check`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/news-api
git commit -m "feat(news-api): posts endpoints with live index, ordering and lookup semantics"
```

---

### Task 8: Live-fixture compatibility suite

**Files:**
- Create: `apps/news-api/src/dev/fixture-world.ts`, `apps/news-api/test/normalize.ts`, `apps/news-api/test/compat.test.ts`, `apps/news-api/scripts/seed-from-fixtures.ts`

**Interfaces:**
- Consumes: `LiveFixture`, `loadLiveFixtures` (Task 2); `createApp`; `createProjectionHandlers`.
- Produces:
  - `buildFixtureEvents(fx: Record<string, LiveFixture>): { source: "core" | "nrms"; type: string; aggregateId: string; data: unknown }[]` — orgs (ministries list, sortOrder = list position; health enriched from `minister-health`), sector/theme/tag terms, category features, posts (all Post objects in any fixture, de-duplicated by key), home, slides (sortIndex = position), resource links
  - `normalize(value: unknown): unknown` — ISO offset datetimes → epoch ms (truncated to ms); drops `newsletterLinks`; drops `timestamp` on link objects (`{uri,key,timestamp}`), which live stamps with request time
  - Dev seed CLI: `DATABASE_URL=… npm --workspace @gcpe/news-api run seed:fixtures`

- [ ] **Step 1: Write the fixture-world builder**

`apps/news-api/src/dev/fixture-world.ts`:
```ts
import type { OrgRecord, ReleaseRecord, SiteContentChanged, TermRecord } from "@gcpe/events";
import type { LiveFixture } from "./fixtures";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface FixtureEvent {
  source: "core" | "nrms";
  type: string;
  aggregateId: string;
  data: unknown;
}

const asList = (fx: LiveFixture | undefined): Json[] => (Array.isArray(fx?.body) ? (fx!.body as Json[]) : fx?.body ? [fx.body as Json] : []);
const isPost = (v: unknown): v is Json => !!v && typeof v === "object" && "atomId" in (v as object) && "documents" in (v as object);

function emailFromHtml(html: string | null): string | null {
  if (html === null) return null;
  if (html === "") return "";
  return /mailto:\s*([^"]+)"/.exec(html)?.[1] ?? html;
}

function social(c: Json) {
  return { twitterUsername: c.twitterFeedUsername, flickrUrl: c.flickrUri, youtubeUrl: c.youtubeUri, audioUrl: c.audioUri };
}

export function postToRelease(p: Json): ReleaseRecord {
  return {
    key: p.key, kind: p.kind, reference: p.reference, atomId: p.atomId, publishDate: p.publishDate, leadMinistryKey: p.leadMinistryKey,
    summary: p.summary, socialMediaSummary: p.socialMediaSummary, socialMediaHeadline: p.socialMediaHeadline, keywords: p.keywords,
    location: p.location, hasMediaAssets: p.hasMediaAssets, hasTranslations: p.hasTranslations, isNewsOnDemand: p.isNewsOnDemand,
    assetUrl: p.assetUrl, redirectUri: p.redirectUri, documents: p.documents, ministryKeys: p.ministryKeys, sectorKeys: p.sectorKeys,
    tagKeys: p.tagKeys, themeKeys: p.themeKeys, assets: p.azureAssets, translations: p.azureTranslations,
    publishFlags: { toWeb: true, toSubscribers: p.isNewsOnDemand, toMediaLists: false }, mediaListKeys: [], renditions: null,
    timestamp: p.timestamp,
  };
}

export function buildFixtureEvents(fx: Record<string, LiveFixture>): FixtureEvent[] {
  const events: FixtureEvent[] = [];
  const minister = fx["minister-health"]?.body as Json | undefined;

  asList(fx["ministries"]).forEach((m, i) => {
    const mi = m.key === "health" ? minister : undefined;
    const org: OrgRecord = {
      key: m.key, displayName: m.name, abbreviation: null, sortOrder: i, isActive: m.isActive, parentKey: m.parentMinistryKey,
      url: m.ministryUrl, displayAdditionalName: m.displayAdditionalName,
      minister: {
        name: m.ministerName, summary: mi?.summary ?? null, detailsHtml: mi?.details ?? null, email: mi ? emailFromHtml(mi.emailHtml) : null,
        photoUrl: mi?.photo ?? null, address: mi?.post ?? null,
      },
      contact: m.contactUser, secondContact: m.secondContactUser, weekendContactNumber: m.weekendContactNumber, social: social(m),
      topicLinks: m.topicLinks.map((l: Json) => ({ text: l.key, url: l.uri })), serviceLinks: m.serviceLinks.map((l: Json) => ({ text: l.key, url: l.uri })),
      sectorKeys: [], updatedAt: m.timestamp,
    };
    events.push({ source: "core", type: "org.upserted", aggregateId: `org:${m.key}`, data: org });
    if (m.topPostKey || m.featurePostKey) {
      events.push({ source: "nrms", type: "site.content.changed", aggregateId: `site:feature:ministries:${m.key}`, data: { entity: "categoryFeatures", kind: "ministries", key: m.key, topPostKey: m.topPostKey, featurePostKey: m.featurePostKey } satisfies SiteContentChanged });
    }
  });

  for (const [listName, termKind, categoryKind] of [["sectors", "sector", "sectors"], ["themes", "theme", "themes"], ["tags", "tag", "tags"]] as const) {
    asList(fx[listName]).forEach((c, i) => {
      const term: TermRecord = { kind: termKind, key: c.key, displayName: c.name, sortOrder: i, isActive: c.isActive, social: social(c), updatedAt: c.timestamp };
      events.push({ source: "core", type: `${termKind}.upserted`, aggregateId: `${termKind}:${c.key}`, data: term });
      if (c.topPostKey || c.featurePostKey) {
        events.push({ source: "nrms", type: "site.content.changed", aggregateId: `site:feature:${categoryKind}:${c.key}`, data: { entity: "categoryFeatures", kind: categoryKind, key: c.key, topPostKey: c.topPostKey, featurePostKey: c.featurePostKey } });
      }
    });
  }

  const seen = new Set<string>();
  for (const f of Object.values(fx)) {
    for (const p of asList(f).filter(isPost)) {
      if (seen.has(p.key)) continue;
      seen.add(p.key);
      events.push({ source: "nrms", type: "release.published", aggregateId: `release:${p.key}`, data: postToRelease(p) });
    }
  }

  const h = fx["home"]?.body as Json | undefined;
  if (h) {
    events.push({ source: "nrms", type: "site.content.changed", aggregateId: "site:home", data: { entity: "home", topPostKey: h.topPostKey, featurePostKey: h.featurePostKey, liveWebcastFlashMediaManifestUrl: h.liveWebcastFlashMediaManifestUrl, liveWebcastM3uPlaylist: h.liveWebcastM3uPlaylist, granville: h.granville, timestamp: h.timestamp } });
  }
  events.push({
    source: "nrms", type: "site.content.changed", aggregateId: "site:slides",
    data: { entity: "slides", slides: asList(fx["slides"]).map((s, i) => ({ id: s.key, sortIndex: i, headline: s.headline, summary: s.summary, actionLabel: s.actionLabel, actionUri: s.actionUri, imageBase64: s.image, imageType: s.imageType, facebookPostUri: s.facebookPostUri, justify: s.justify, timestamp: s.timestamp })) },
  });
  events.push({
    source: "nrms", type: "site.content.changed", aggregateId: "site:resourceLinks",
    data: { entity: "resourceLinks", links: asList(fx["resource-links"]).map((l, i) => ({ sortIndex: i, text: l.key, uri: l.uri })), timestamp: new Date().toISOString() },
  });
  return events;
}
```

`apps/news-api/test/normalize.ts`:
```ts
const ISO_OFFSET = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?([+-]\d\d:\d\d|Z)$/;

const isLink = (o: Record<string, unknown>) => Object.keys(o).length === 3 && "uri" in o && "key" in o && "timestamp" in o;

export function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === "newsletterLinks") continue;
      if (k === "timestamp" && isLink(o)) continue;
      out[k] = normalize(v);
    }
    return out;
  }
  if (typeof value === "string" && ISO_OFFSET.test(value)) return Date.parse(value.replace(/(\.\d{3})\d+/, "$1"));
  return value;
}
```

- [ ] **Step 2: Write the compatibility test**

`apps/news-api/test/compat.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createApp } from "../src/app";
import { loadLiveFixtures, type LiveFixture } from "../src/dev/fixtures";
import { buildFixtureEvents } from "../src/dev/fixture-world";
import { createNewsTestDb, envelope, EVENT_SECRETS, sendEvent, TZ } from "./helpers";
import { normalize } from "./normalize";

const fx = loadLiveFixtures();

// Fixtures whose full response (status + normalized body) must match exactly.
const EXACT = [
  "post-first", "post-first-lowercase", "posts-multi", "post-unknown", "featured-posts", "keys-reference", "keys-reference-unknown",
  "latest-home", "latest-ministry-health", "keys-home", "keys-home-skip", "keys-home-advisories", "keys-ministry-health-upper",
  "keys-unknown-kind", "home", "home-no-version", "ministries", "ministry-health", "minister-health", "ministry-unknown",
  "sectors", "sector-first", "sector-unknown", "themes", "theme-first", "theme-unknown", "tags", "tag-first", "tag-unknown",
  "slides", "slide-first", "slide-unknown", "resource-links",
];

describe("News API v1 compatibility with recorded live responses", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    tdb = await createNewsTestDb();
    app = createApp({ db: tdb.db, timeZone: TZ, eventSecrets: EVENT_SECRETS });
    for (const e of buildFixtureEvents(fx)) await sendEvent(app, envelope(e.source, e.type, e.aggregateId, e.data));
  }, 120_000);
  afterAll(async () => {
    await tdb.drop();
  });

  async function replay(f: LiveFixture) {
    const res = await request(app).get(f.path);
    const body = res.text.length ? JSON.parse(res.text) : null;
    return { status: res.status, body };
  }

  for (const name of EXACT) {
    it(`matches ${name}`, async () => {
      const f = fx[name]!;
      const ours = await replay(f);
      expect(ours.status).toBe(f.status);
      expect(normalize(ours.body)).toEqual(normalize(f.body));
    });
  }

  it("matches latest-home-* kinds (first post only; older posts may be absent from the fixture world)", async () => {
    for (const kind of ["factsheets", "stories", "updates"]) {
      const f = fx[`latest-home-${kind}`]!;
      const ours = await replay(f);
      expect(ours.status).toBe(f.status);
      expect((ours.body as { key: string }[])[0]?.key).toBe((f.body as { key: string }[])[0]?.key);
    }
  });

  it("matches error semantics for unsupported version, unknown theme index and media URI", async () => {
    const bad = await replay(fx["home-bad-version"]!);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe((fx["home-bad-version"]!.body as { error: { code: string } }).error.code);
    const theme = await replay(fx["keys-theme-unknown"]!);
    expect(theme.status).toBe(404);
    expect(theme.body).toMatchObject({ title: "Not Found", status: 404 });
    expect((await replay(fx["latest-media-video"]!)).status).toBe(fx["latest-media-video"]!.status);
  });
});
```

- [ ] **Step 3: Run the compatibility suite**

Run: `npx vitest run apps/news-api/test/compat.test.ts`
Expected: all PASS. **If any `matches …` case fails:** the diff shows a real behavioural difference from live. Fix the serializer or query so it matches. Do not edit the fixture, and do not add the name to an ignore list. The one tolerated difference is already handled in `normalize` (`newsletterLinks`, link timestamps).

- [ ] **Step 4: Dev seed script**

`apps/news-api/scripts/seed-from-fixtures.ts`:
```ts
// Loads the recorded fixture world into a local News API database (for manual testing with gcpe-news-webapp).
import { randomUUID } from "node:crypto";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { parseEvent } from "@gcpe/events";
import { loadLiveFixtures } from "../src/dev/fixtures";
import { buildFixtureEvents } from "../src/dev/fixture-world";
import { createProjectionHandlers } from "../src/projections";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const { db, pool } = createDb(url);
await runMigrations(db, new URL("../migrations", import.meta.url).pathname);
const handlers = createProjectionHandlers();
let n = 0;
for (const e of buildFixtureEvents(loadLiveFixtures())) {
  const event = parseEvent({ id: randomUUID(), type: e.type, version: 1, source: e.source, aggregateId: e.aggregateId, sequence: 1, occurredAt: new Date().toISOString(), correlationId: randomUUID(), data: e.data });
  await db.transaction((tx) => handlers[e.type]!(tx, event));
  n++;
}
console.log(`applied ${n} fixture events`);
await pool.end();
```

- [ ] **Step 5: Run everything**

Run: `npm test && npm run check`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/news-api
git commit -m "test(news-api): live-fixture compatibility suite and dev seed"
```

---

### Task 9: SignalR `/updates` hub

**Files:**
- Create: `apps/news-api/src/updates/hub.ts`
- Test: `apps/news-api/src/updates/hub.test.ts`

**Interfaces:**
- Consumes: `UpdateTarget`, `listenForUpdates` (Task 4).
- Produces:
  - `interface UpdatesHub { router: express.Router; attach(server: http.Server): void; broadcast(target: UpdateTarget, keys: string[]): void; connectionCount(): number; close(): void }`
  - `createUpdatesHub(opts?: { path?: string; pingMs?: number; tokenTtlMs?: number }): UpdatesHub` — defaults: path `/updates`, ping 15000 ms, token TTL 60000 ms
  - Protocol: `POST {path}/negotiate` → v1 `{ negotiateVersion: 1, connectionId, connectionToken, availableTransports: [{ transport: "WebSockets", transferFormats: ["Text", "Binary"] }] }` (v0 when `negotiateVersion` absent: `{ connectionId, availableTransports }`, id = token); WebSocket upgrade at `{path}?id=<token>`; handshake `{"protocol":"json","version":1}\x1e` → `{}\x1e`; invocations `{"type":1,"target":T,"arguments":[keys]}\x1e`; pings `{"type":6}\x1e`

- [ ] **Step 1: Write the failing test (official client as the oracle)**

`apps/news-api/src/updates/hub.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HubConnectionBuilder, HubConnectionState, LogLevel, type HubConnection } from "@microsoft/signalr";
import { createUpdatesHub, type UpdatesHub } from "./hub";

async function start(hubOpts: Parameters<typeof createUpdatesHub>[0] = {}, port = 0) {
  const hub = createUpdatesHub(hubOpts);
  const app = express();
  app.use(hub.router);
  const server = createServer(app);
  hub.attach(server);
  await new Promise<void>((r) => server.listen(port, r));
  return { hub, server, port: (server.address() as AddressInfo).port };
}

function client(port: number, serverTimeoutMs = 30_000): HubConnection {
  const c = new HubConnectionBuilder().withUrl(`http://127.0.0.1:${port}/updates`).configureLogging(LogLevel.None).build();
  c.serverTimeoutInMilliseconds = serverTimeoutMs;
  return c;
}

describe("SignalR updates hub", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });
  const track = (hub: UpdatesHub, server: Server, conn?: HubConnection) =>
    cleanups.push(async () => {
      await conn?.stop();
      hub.close();
      await new Promise((r) => server.close(r));
    });

  it("delivers PostUpdate invocations with the key array", async () => {
    const { hub, server, port } = await start();
    const conn = client(port);
    track(hub, server, conn);
    const got = new Promise<string[]>((resolve) => conn.on("PostUpdate", (keys: string[]) => resolve(keys)));
    await conn.start();
    expect(hub.connectionCount()).toBe(1);
    hub.broadcast("PostUpdate", ["2026TT0103-001121"]);
    expect(await got).toEqual(["2026TT0103-001121"]);
  });

  it("keeps the connection alive with pings", async () => {
    const { hub, server, port } = await start({ pingMs: 50 });
    const conn = client(port, 300);
    track(hub, server, conn);
    await conn.start();
    await new Promise((r) => setTimeout(r, 800));
    expect(conn.state).toBe(HubConnectionState.Connected);
  });

  it("rejects a WebSocket upgrade without a negotiated token", async () => {
    const { hub, server, port } = await start();
    track(hub, server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/updates?id=bogus`);
    const outcome = await new Promise((r) => {
      ws.onopen = () => r("open");
      ws.onerror = () => r("error");
    });
    expect(outcome).toBe("error");
  });

  it("client reconnects after hub restart", async () => {
    const first = await start();
    const conn = client(first.port);
    await conn.start();
    await conn.stop();
    first.hub.close();
    await new Promise((r) => first.server.close(r));

    const second = await start({}, first.port);
    const conn2 = client(second.port);
    track(second.hub, second.server, conn2);
    await conn2.start();
    expect(second.hub.connectionCount()).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/news-api/src/updates/hub.test.ts`
Expected: FAIL — cannot resolve `./hub`.

- [ ] **Step 3: Implement the hub**

`apps/news-api/src/updates/hub.ts`:
```ts
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import type { UpdateTarget } from "./notify";

const RS = "\u001e";

export interface UpdatesHub {
  router: express.Router;
  attach(server: Server): void;
  broadcast(target: UpdateTarget, keys: string[]): void;
  connectionCount(): number;
  close(): void;
}

export function createUpdatesHub(opts: { path?: string; pingMs?: number; tokenTtlMs?: number } = {}): UpdatesHub {
  const path = opts.path ?? "/updates";
  const pending = new Map<string, NodeJS.Timeout>();
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });

  const router = express.Router();
  router.post(`${path}/negotiate`, (req, res) => {
    const token = randomUUID();
    pending.set(token, setTimeout(() => pending.delete(token), opts.tokenTtlMs ?? 60_000).unref());
    const transports = [{ transport: "WebSockets", transferFormats: ["Text", "Binary"] }];
    if (req.query.negotiateVersion === "1") {
      res.json({ negotiateVersion: 1, connectionId: randomUUID(), connectionToken: token, availableTransports: transports });
    } else {
      res.json({ connectionId: token, availableTransports: transports });
    }
  });

  function onConnection(ws: WebSocket) {
    let handshaken = false;
    ws.on("message", (data) => {
      const frames = data.toString().split(RS).filter(Boolean);
      for (const frame of frames) {
        let msg: { protocol?: string; type?: number };
        try {
          msg = JSON.parse(frame);
        } catch {
          ws.close(1003);
          return;
        }
        if (!handshaken) {
          if (msg.protocol !== "json") {
            ws.send(JSON.stringify({ error: `Requested protocol '${msg.protocol}' is not available.` }) + RS);
            ws.close();
            return;
          }
          handshaken = true;
          sockets.add(ws);
          ws.send("{}" + RS);
        } else if (msg.type === 7) {
          ws.close();
        }
      }
    });
    ws.on("close", () => sockets.delete(ws));
    ws.on("error", () => sockets.delete(ws));
  }

  const pingTimer = setInterval(() => {
    for (const s of sockets) if (s.readyState === s.OPEN) s.send(JSON.stringify({ type: 6 }) + RS);
  }, opts.pingMs ?? 15_000);
  pingTimer.unref();

  return {
    router,
    attach(server: Server) {
      server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = new URL(req.url ?? "", "http://localhost");
        const id = url.searchParams.get("id");
        if (url.pathname !== path || !id || !pending.has(id)) {
          socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        clearTimeout(pending.get(id));
        pending.delete(id);
        wss.handleUpgrade(req, socket, head, onConnection);
      });
    },
    broadcast(target, keys) {
      const frame = JSON.stringify({ type: 1, target, arguments: [keys] }) + RS;
      for (const s of sockets) if (s.readyState === s.OPEN) s.send(frame);
    },
    connectionCount: () => sockets.size,
    close() {
      clearInterval(pingTimer);
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      for (const s of sockets) s.terminate();
      sockets.clear();
      wss.close();
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run apps/news-api/src/updates && npm run check`
Expected: 4 tests PASS. (Node 22 provides the global `WebSocket` used by the rejection test and by `@microsoft/signalr`.)

- [ ] **Step 5: Commit**

```bash
git add apps/news-api
git commit -m "feat(news-api): SignalR-compatible /updates hub for gcpe-news-webapp cache invalidation"
```

---

### Task 10: Subscribe proxy to NoD

**Files:**
- Create: `apps/news-api/src/http/v1/subscribe.ts`
- Modify: `apps/news-api/src/app.ts` (mount the proxy before other routers; move `SubscribeProxyOptions` export to `subscribe.ts` and re-export it from `app.ts`)
- Test: `apps/news-api/src/http/v1/subscribe.test.ts`

**Interfaces:**
- Produces:
  - `interface SubscribeProxyOptions { baseUrl: string; getToken?: () => Promise<string>; rateLimitPerMinute: number; fetchImpl?: typeof fetch }`
  - `subscribeRoutes(opts: SubscribeProxyOptions | undefined): Router` — handles the 7 swagger paths under `/Subscribe/*`, forwarding method, path, query (minus `api-version`) and JSON body to `${baseUrl}/api/Subscribe/<rest>`, adding `Authorization: Bearer <token>` when `getToken` is set; passes status, `content-type` and body back. When `opts` is undefined → `503 {"error":"subscriptions unavailable"}`. Rate-limited per client IP (`rateLimitPerMinute`, default 300 in `main.ts`, high because `gcpe-news-webapp` calls server-side from one IP).
  - Contract for NoD (Phase 4): NoD serves the same paths under `/api/Subscribe/*` with the same request/response shapes as the swagger.
  - CAPTCHA (spec §6.3) is **not** applied to v1 because v1 callers are server-side (`gcpe-news-webapp`'s `SubscribeController`). It belongs on the new static site's browser form (Phase 6).

- [ ] **Step 1: Write the failing test**

`apps/news-api/src/http/v1/subscribe.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { subscribeRoutes } from "./subscribe";

describe("Subscribe proxy", () => {
  let nod: Server;
  let nodUrl: string;
  const seen: { method: string; url: string; auth?: string; body: unknown }[] = [];

  beforeAll(async () => {
    const stub = express();
    stub.use(express.json());
    stub.all("/{*rest}", (req, res) => {
      seen.push({ method: req.method, url: req.originalUrl, auth: req.header("authorization"), body: req.body });
      if (req.path.endsWith("/CheckEmailActivationToken/bad")) return void res.status(404).json({ message: "nope" });
      res.json(true);
    });
    nod = await new Promise<Server>((r) => {
      const s = stub.listen(0, () => r(s));
    });
    nodUrl = `http://127.0.0.1:${(nod.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    nod.close();
  });

  function app(opts: Parameters<typeof subscribeRoutes>[0]) {
    const a = express();
    a.use("/api", subscribeRoutes(opts));
    return a;
  }

  it("forwards GET with token, dropping api-version", async () => {
    const res = await request(app({ baseUrl: nodUrl, getToken: async () => "tok", rateLimitPerMinute: 100 })).get(
      "/api/Subscribe/SubscriptionItems/ministries?api-version=1.0",
    );
    expect(res.body).toBe(true);
    expect(seen.at(-1)).toMatchObject({ method: "GET", url: "/api/Subscribe/SubscriptionItems/ministries", auth: "Bearer tok" });
  });

  it("forwards POST bodies and passes status codes through", async () => {
    const a = app({ baseUrl: nodUrl, rateLimitPerMinute: 100 });
    await request(a).post("/api/Subscribe/CreateNewsOnDemandEmailSubscriptionWithPreferences?api-version=1.0").send({ emailAddress: "a@b.c", isAsItHappens: true });
    expect(seen.at(-1)!.body).toEqual({ emailAddress: "a@b.c", isAsItHappens: true });
    expect((await request(a).get("/api/Subscribe/CheckEmailActivationToken/bad?api-version=1.0")).status).toBe(404);
  });

  it("503 when NoD is not configured", async () => {
    expect((await request(app(undefined)).get("/api/Subscribe/SubscriptionItems/x?api-version=1.0")).status).toBe(503);
  });

  it("rate limits per client", async () => {
    const a = app({ baseUrl: nodUrl, rateLimitPerMinute: 2 });
    await request(a).get("/api/Subscribe/SubscriptionItems/x");
    await request(a).get("/api/Subscribe/SubscriptionItems/x");
    expect((await request(a).get("/api/Subscribe/SubscriptionItems/x")).status).toBe(429);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/news-api/src/http/v1/subscribe.test.ts`
Expected: FAIL — cannot resolve `./subscribe`.

- [ ] **Step 3: Implement**

`apps/news-api/src/http/v1/subscribe.ts`:
```ts
import express, { Router } from "express";
import { rateLimit } from "express-rate-limit";

export interface SubscribeProxyOptions {
  baseUrl: string;
  getToken?: () => Promise<string>;
  rateLimitPerMinute: number;
  fetchImpl?: typeof fetch;
}

const ROUTES: [method: "get" | "post", path: string][] = [
  ["get", "/Subscribe/SubscriptionItems/:categoryKey"],
  ["post", "/Subscribe/CreateNewsOnDemandEmailSubscriptionWithPreferences"],
  ["get", "/Subscribe/ConfirmUpdateCreateSubscription/:tokenGuid"],
  ["post", "/Subscribe/UpdateNewsOnDemandEmailSubscriptionWithPreferences/:tokenGuid"],
  ["get", "/Subscribe/ManageNewsOnDemandEmailSubscription/:emailAddress"],
  ["get", "/Subscribe/CheckEmailActivationToken/:tokenGuid"],
  ["get", "/Subscribe/UnsubscribeSubscriber/:tokenGuid"],
];

export function subscribeRoutes(opts: SubscribeProxyOptions | undefined): Router {
  const r = Router();
  if (!opts) {
    r.all("/Subscribe/{*rest}", (_req, res) => void res.status(503).json({ error: "subscriptions unavailable" }));
    return r;
  }
  const doFetch = opts.fetchImpl ?? fetch;
  r.use("/Subscribe", rateLimit({ windowMs: 60_000, limit: opts.rateLimitPerMinute, standardHeaders: "draft-8", legacyHeaders: false }));

  for (const [method, path] of ROUTES) {
    r[method](path, express.json({ limit: "100kb" }), async (req, res) => {
      const query = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query)) {
        if (k === "api-version") continue;
        for (const value of Array.isArray(v) ? v : [v]) if (typeof value === "string") query.append(k, value);
      }
      const qs = query.toString();
      const target = `${opts.baseUrl.replace(/\/$/, "")}/api${req.path}${qs ? `?${qs}` : ""}`;
      const headers: Record<string, string> = { accept: "application/json" };
      if (opts.getToken) headers.authorization = `Bearer ${await opts.getToken()}`;
      if (method === "post") headers["content-type"] = "application/json";
      try {
        const upstream = await doFetch(target, {
          method: method.toUpperCase(),
          headers,
          body: method === "post" ? JSON.stringify(req.body ?? null) : undefined,
          signal: AbortSignal.timeout(15_000),
        });
        const text = await upstream.text();
        res.status(upstream.status);
        const type = upstream.headers.get("content-type");
        if (type) res.set("content-type", type);
        res.send(text);
      } catch (e) {
        console.error("[news-api] subscribe proxy failed", e);
        res.status(502).json({ error: "subscriptions upstream unavailable" });
      }
    });
  }
  return r;
}
```

In `apps/news-api/src/app.ts`: delete the local `SubscribeProxyOptions` interface, add
```ts
import { subscribeRoutes, type SubscribeProxyOptions } from "./http/v1/subscribe";
export type { SubscribeProxyOptions };
```
and mount it as the **first** router on `api` (after `requireApiVersion` and the cache header):
```ts
  api.use(subscribeRoutes(deps.subscribe));
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run apps/news-api && npm run check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/news-api
git commit -m "feat(news-api): Subscribe endpoints proxied to NoD with rate limiting"
```

---

### Task 11: Legacy importer (posts and site content)

**Files:**
- Create: `apps/news-api/src/import/queries.ts`, `apps/news-api/src/import/map.ts`, `apps/news-api/src/import/run.ts`, `apps/news-api/src/import/cli.ts`
- Test: `apps/news-api/src/import/map.test.ts`, `apps/news-api/src/import/run.test.ts`

**Interfaces:**
- Consumes: `LegacySource`, `createFakeSource`, `createMssqlSource`, `releaseKindFromLegacy`, `hasPublishOption`, `PUBLISH_OPTIONS` (Phase 0 Task 8); `applyRelease`, `applySiteContent` (Task 4).
- Produces:
  - Queries (first line `-- name: …`; per-year names `releases:<year>`, `documents:<year>`, `contacts:<year>`, `releaseIndexes:<year>`): `Q_RELEASE_YEARS`, `qReleases(year)`, `qDocuments(year)`, `qContacts(year)`, `qReleaseIndexes(year)`, `Q_RELEASE_KEYS_BY_ID`, `Q_APP_SETTINGS`, `Q_CATEGORY_FEATURES`, `Q_CURRENT_SLIDES`, `Q_RESOURCE_LINKS`
  - `mapLegacyRelease(row: LegacyReleaseRow, docs: LegacyDocumentRow[], contacts: LegacyContactRow[], indexes: LegacyIndexRow[]): ReleaseRecord`
  - `splitContact(information: string): { title: string | null; details: string | null }`
  - `justifyFromLegacy(value: number | null): string | null` (0 → `"left"`, 1 → `"right"`, else `null`)
  - `imageTypeFromBytes(buf: Buffer | null): string | null` (PNG/JPEG/GIF magic bytes)
  - `importLegacyNews(db: Db, source: LegacySource, opts?: { timeZone?: string; log?: (msg: string) => void }): Promise<{ releases: number; slides: number; resourceLinks: number; features: number }>`

**Mapping rules (legacy `Gcpe.Hub` → `ReleaseRecord`).** Rows marked *(inferred)* are assumptions; Review Focus #1 schedules their verification.

| Field | Source |
|---|---|
| filter | `IsCommitted = 1 AND IsPublished = 1 AND IsActive = 1` (legacy `GetPublished`) |
| `key`, `reference`, `keywords`, `assetUrl`, `hasMediaAssets` | `Key`, `Reference`, `Keywords`, `AssetUrl`, `HasMediaAssets` (verbatim) |
| `kind` | `releaseKindFromLegacy(ReleaseType)` |
| `atomId` | `AtomId` if non-empty else `"uuid:" + lower(Id)` (legacy `GetAtomId`) |
| `publishDate`, `timestamp` | `PublishDateTime`, `Timestamp` (datetimeoffset) |
| `leadMinistryKey` | `Ministry.Key` via `MinistryId` |
| `summary`, `location`, `socialMediaHeadline`, `socialMediaSummary` | English (`4105`) `NewsReleaseLanguage` row |
| `isNewsOnDemand` | `PublishOptions & 2` |
| `redirectUri` | `RedirectUrl`, `""` → `null` *(inferred: live shows `null` while the column is NOT NULL)* |
| `documents` | `NewsReleaseDocument` × `NewsReleaseDocumentLanguage`, ordered by `SortIndex`, then English first, then `LanguageId`; `detailsHtml` = `BodyHtml` |
| document `contacts` | `NewsReleaseDocumentContact` for that document+language ordered by `SortIndex`; `Information` split on the first line break → `title` / `details` (remaining lines joined with `\n`) *(inferred)* |
| `ministryKeys`/`sectorKeys`/`tagKeys`/`themeKeys` | join tables, sorted alphabetically |
| `hasTranslations`, `assets`, `translations` | `false`, `null`, `null` (translations/assets lived in Azure Blob; migrated in a later phase) |
| `publishFlags` | `toWeb: true`, `toSubscribers: isNewsOnDemand`, `toMediaLists: PublishOptions & 4` |
| Home top/feature | `ApplicationSetting` `HomeTopReleaseId` / `HomeFeatureReleaseId` (GUIDs → release keys); `granville` setting |
| Category top/feature | `Ministry`/`Sector`/`Theme` `TopReleaseId` / `FeatureReleaseId` → keys |
| Slides | Latest `Carousel` with `PublishDateTime <= now`, its `CarouselSlide` rows by `SortIndex` joined to `Slide`; `actionLabel` = `null` *(the legacy `Slide` table has no ActionLabel column; live shows "READ MORE", so the source is unverified)*; `justify` via `justifyFromLegacy` *(inferred)*; `imageType` from magic bytes |
| Resource links | `ResourceLink` (`SortIndex`, `LinkText`, `LinkUrl`) |

- [ ] **Step 1: Write the failing mapper test**

`apps/news-api/src/import/map.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { imageTypeFromBytes, justifyFromLegacy, mapLegacyRelease, splitContact, type LegacyReleaseRow } from "./map";

const row: LegacyReleaseRow = {
  Id: "9AF8CC16-0AE5-4EC6-AD58-FDB081D44E37", Key: "2026TT0103-001121", ReleaseType: 1, Reference: "NEWS-34336", AtomId: "",
  PublishDateTime: new Date("2026-10-01T22:10:00Z"), LeadMinistryKey: "transportation-and-transit", Keywords: "", AssetUrl: "",
  RedirectUrl: "", HasMediaAssets: false, PublishOptions: 3, Timestamp: new Date("2026-10-01T22:10:28.037Z"),
  Location: "Abbotsford", Summary: "Drivers can expect…", SocialMediaHeadline: null, SocialMediaSummary: null,
};

describe("mapLegacyRelease", () => {
  it("maps a legacy release to the published-content record", () => {
    const r = mapLegacyRelease(
      row,
      [
        { ReleaseId: row.Id, DocumentId: "d1", SortIndex: 0, LanguageId: 3084, PageTitle: "Avis", Headline: "FR", Subheadline: "", Byline: "", BodyHtml: "<p>fr</p>" },
        { ReleaseId: row.Id, DocumentId: "d1", SortIndex: 0, LanguageId: 4105, PageTitle: "Traffic Advisory", Headline: "Traffic-pattern change", Subheadline: "", Byline: "", BodyHtml: "<p>en</p>" },
      ],
      [{ DocumentId: "d1", LanguageId: 4105, SortIndex: 0, Information: "Ministry of Transportation and Transit\r\nMedia Relations\r\n250-356-8241" }],
      [
        { ReleaseId: row.Id, IndexKind: "sectors", IndexKey: "services" },
        { ReleaseId: row.Id, IndexKind: "sectors", IndexKey: "government-operations" },
        { ReleaseId: row.Id, IndexKind: "ministries", IndexKey: "transportation-and-transit" },
      ],
    );
    expect(r).toMatchObject({
      key: "2026TT0103-001121", kind: "releases", reference: "NEWS-34336", atomId: "uuid:9af8cc16-0ae5-4ec6-ad58-fdb081d44e37",
      publishDate: "2026-10-01T22:10:00.000Z", isNewsOnDemand: true, redirectUri: null, assetUrl: "", hasTranslations: false,
      ministryKeys: ["transportation-and-transit"], sectorKeys: ["government-operations", "services"], tagKeys: [], themeKeys: [],
      publishFlags: { toWeb: true, toSubscribers: true, toMediaLists: false },
    });
    expect(r.documents.map((d) => d.languageId)).toEqual([4105, 3084]);
    expect(r.documents[0]!.contacts).toEqual([{ title: "Ministry of Transportation and Transit", details: "Media Relations\n250-356-8241" }]);
    expect(r.documents[1]!.contacts).toEqual([]);
  });

  it("uses a stored AtomId and the story kind (ReleaseType 2)", () => {
    const r = mapLegacyRelease({ ...row, ReleaseType: 2, AtomId: "tag:x" }, [], [], []);
    expect([r.kind, r.atomId]).toEqual(["stories", "tag:x"]);
  });

  it("throws on ReleaseType 0", () => {
    expect(() => mapLegacyRelease({ ...row, ReleaseType: 0 }, [], [], [])).toThrow(/ReleaseType 0/);
  });
});

describe("helpers", () => {
  it("splits contacts", () => {
    expect(splitContact("Single line")).toEqual({ title: "Single line", details: "" });
    expect(splitContact("")).toEqual({ title: "", details: "" });
  });
  it("maps justify and image types", () => {
    expect([justifyFromLegacy(0), justifyFromLegacy(1), justifyFromLegacy(7), justifyFromLegacy(null)]).toEqual(["left", "right", null, null]);
    expect(imageTypeFromBytes(Buffer.from("89504e470d0a1a0a", "hex"))).toBe("image/png");
    expect(imageTypeFromBytes(Buffer.from("ffd8ffe0", "hex"))).toBe("image/jpeg");
    expect(imageTypeFromBytes(Buffer.from("474946383961", "hex"))).toBe("image/gif");
    expect(imageTypeFromBytes(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/news-api/src/import/map.test.ts`
Expected: FAIL — cannot resolve `./map`.

- [ ] **Step 3: Implement queries and mapper**

`apps/news-api/src/import/queries.ts`:
```ts
const PUBLISHED = "r.IsCommitted = 1 AND r.IsPublished = 1 AND r.IsActive = 1";
const year = (y: number) => `${PUBLISHED} AND YEAR(r.PublishDateTime) = ${Math.trunc(y)}`;

export const Q_RELEASE_YEARS = `-- name: releaseYears
SELECT DISTINCT YEAR(r.PublishDateTime) AS [Year] FROM dbo.NewsRelease r WHERE ${PUBLISHED} AND r.PublishDateTime IS NOT NULL`;

export const qReleases = (y: number) => `-- name: releases:${y}
SELECT r.Id, r.[Key], r.ReleaseType, r.Reference, r.AtomId, r.PublishDateTime, m.[Key] AS LeadMinistryKey, r.Keywords, r.AssetUrl,
       r.RedirectUrl, r.HasMediaAssets, r.PublishOptions, r.[Timestamp],
       l.Location, l.Summary, l.SocialMediaHeadline, l.SocialMediaSummary
FROM dbo.NewsRelease r
LEFT JOIN dbo.Ministry m ON m.Id = r.MinistryId
LEFT JOIN dbo.NewsReleaseLanguage l ON l.ReleaseId = r.Id AND l.LanguageId = 4105
WHERE ${year(y)}`;

export const qDocuments = (y: number) => `-- name: documents:${y}
SELECT d.ReleaseId, d.Id AS DocumentId, d.SortIndex, dl.LanguageId, dl.PageTitle, dl.Headline, dl.Subheadline, dl.Byline, dl.BodyHtml
FROM dbo.NewsReleaseDocument d
JOIN dbo.NewsReleaseDocumentLanguage dl ON dl.DocumentId = d.Id
JOIN dbo.NewsRelease r ON r.Id = d.ReleaseId
WHERE ${year(y)}`;

export const qContacts = (y: number) => `-- name: contacts:${y}
SELECT c.DocumentId, c.LanguageId, c.SortIndex, c.Information
FROM dbo.NewsReleaseDocumentContact c
JOIN dbo.NewsReleaseDocument d ON d.Id = c.DocumentId
JOIN dbo.NewsRelease r ON r.Id = d.ReleaseId
WHERE ${year(y)}`;

export const qReleaseIndexes = (y: number) => `-- name: releaseIndexes:${y}
SELECT x.ReleaseId, 'ministries' AS IndexKind, m.[Key] AS IndexKey FROM dbo.NewsReleaseMinistry x JOIN dbo.Ministry m ON m.Id = x.MinistryId JOIN dbo.NewsRelease r ON r.Id = x.ReleaseId WHERE ${year(y)}
UNION ALL SELECT x.ReleaseId, 'sectors', s.[Key] FROM dbo.NewsReleaseSector x JOIN dbo.Sector s ON s.Id = x.SectorId JOIN dbo.NewsRelease r ON r.Id = x.ReleaseId WHERE ${year(y)}
UNION ALL SELECT x.ReleaseId, 'tags', t.[Key] FROM dbo.NewsReleaseTag x JOIN dbo.Tag t ON t.Id = x.TagId JOIN dbo.NewsRelease r ON r.Id = x.ReleaseId WHERE ${year(y)}
UNION ALL SELECT x.ReleaseId, 'themes', t.[Key] FROM dbo.NewsReleaseTheme x JOIN dbo.Theme t ON t.Id = x.ThemeId JOIN dbo.NewsRelease r ON r.Id = x.ReleaseId WHERE ${year(y)}`;

export const Q_RELEASE_KEYS_BY_ID = `-- name: releaseKeysById
SELECT r.Id, r.[Key] FROM dbo.NewsRelease r WHERE ${PUBLISHED}`;

export const Q_APP_SETTINGS = `-- name: appSettings
SELECT SettingName, SettingValue FROM dbo.ApplicationSetting WHERE SettingName IN ('HomeTopReleaseId', 'HomeFeatureReleaseId', 'granville')`;

export const Q_CATEGORY_FEATURES = `-- name: categoryFeatures
SELECT 'ministries' AS Kind, [Key], TopReleaseId, FeatureReleaseId FROM dbo.Ministry WHERE TopReleaseId IS NOT NULL OR FeatureReleaseId IS NOT NULL
UNION ALL SELECT 'sectors', [Key], TopReleaseId, FeatureReleaseId FROM dbo.Sector WHERE TopReleaseId IS NOT NULL OR FeatureReleaseId IS NOT NULL
UNION ALL SELECT 'themes', [Key], TopReleaseId, FeatureReleaseId FROM dbo.Theme WHERE TopReleaseId IS NOT NULL OR FeatureReleaseId IS NOT NULL`;

export const Q_CURRENT_SLIDES = `-- name: currentSlides
SELECT s.Id, cs.SortIndex, s.Headline, s.Summary, s.ActionUrl, s.Image, s.FacebookPostUrl, s.Justify, s.[Timestamp]
FROM dbo.CarouselSlide cs
JOIN dbo.Slide s ON s.Id = cs.SlideId
WHERE cs.CarouselId = (SELECT TOP 1 c.Id FROM dbo.Carousel c WHERE c.PublishDateTime <= SYSDATETIMEOFFSET() ORDER BY c.PublishDateTime DESC)
ORDER BY cs.SortIndex`;

export const Q_RESOURCE_LINKS = `-- name: resourceLinks
SELECT SortIndex, LinkText, LinkUrl FROM dbo.ResourceLink ORDER BY SortIndex`;
```

`apps/news-api/src/import/map.ts`:
```ts
import type { ReleaseRecord } from "@gcpe/events";
import { hasPublishOption, PUBLISH_OPTIONS, releaseKindFromLegacy } from "@gcpe/legacy-import";

export interface LegacyReleaseRow extends Record<string, unknown> {
  Id: string;
  Key: string;
  ReleaseType: number;
  Reference: string | null;
  AtomId: string | null;
  PublishDateTime: Date;
  LeadMinistryKey: string | null;
  Keywords: string | null;
  AssetUrl: string | null;
  RedirectUrl: string | null;
  HasMediaAssets: boolean;
  PublishOptions: number;
  Timestamp: Date;
  Location: string | null;
  Summary: string | null;
  SocialMediaHeadline: string | null;
  SocialMediaSummary: string | null;
}

export interface LegacyDocumentRow extends Record<string, unknown> {
  ReleaseId: string;
  DocumentId: string;
  SortIndex: number;
  LanguageId: number;
  PageTitle: string | null;
  Headline: string | null;
  Subheadline: string | null;
  Byline: string | null;
  BodyHtml: string | null;
}

export interface LegacyContactRow extends Record<string, unknown> {
  DocumentId: string;
  LanguageId: number;
  SortIndex: number;
  Information: string;
}

export interface LegacyIndexRow extends Record<string, unknown> {
  ReleaseId: string;
  IndexKind: "ministries" | "sectors" | "tags" | "themes";
  IndexKey: string;
}

export function splitContact(information: string): { title: string | null; details: string | null } {
  const [title = "", ...rest] = information.split(/\r?\n/);
  return { title, details: rest.join("\n") };
}

export function justifyFromLegacy(value: number | null): string | null {
  if (value === 0) return "left";
  if (value === 1) return "right";
  return null;
}

export function imageTypeFromBytes(buf: Buffer | null): string | null {
  if (!buf || buf.length < 4) return null;
  if (buf.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  return null;
}

const languageOrder = (id: number) => (id === 4105 ? 0 : 1);

export function mapLegacyRelease(
  row: LegacyReleaseRow,
  docs: LegacyDocumentRow[],
  contacts: LegacyContactRow[],
  indexes: LegacyIndexRow[],
): ReleaseRecord {
  const kind = releaseKindFromLegacy(row.ReleaseType) as ReleaseRecord["kind"];
  const keysOf = (k: LegacyIndexRow["IndexKind"]) => indexes.filter((i) => i.IndexKind === k).map((i) => i.IndexKey).sort();
  const documents = [...docs]
    .sort((a, b) => a.SortIndex - b.SortIndex || languageOrder(a.LanguageId) - languageOrder(b.LanguageId) || a.LanguageId - b.LanguageId)
    .map((d) => ({
      pageTitle: d.PageTitle,
      languageId: d.LanguageId,
      headline: d.Headline,
      subheadline: d.Subheadline,
      detailsHtml: d.BodyHtml,
      byline: d.Byline,
      contacts: contacts
        .filter((c) => c.DocumentId.toLowerCase() === d.DocumentId.toLowerCase() && c.LanguageId === d.LanguageId)
        .sort((a, b) => a.SortIndex - b.SortIndex)
        .map((c) => splitContact(c.Information)),
    }));
  const isNewsOnDemand = hasPublishOption(row.PublishOptions, PUBLISH_OPTIONS.NewsOnDemand);
  return {
    key: row.Key,
    kind,
    reference: row.Reference,
    atomId: row.AtomId ? row.AtomId : `uuid:${row.Id.toLowerCase()}`,
    publishDate: row.PublishDateTime.toISOString(),
    leadMinistryKey: row.LeadMinistryKey,
    summary: row.Summary,
    socialMediaSummary: row.SocialMediaSummary,
    socialMediaHeadline: row.SocialMediaHeadline,
    keywords: row.Keywords,
    location: row.Location,
    hasMediaAssets: Boolean(row.HasMediaAssets),
    hasTranslations: false,
    isNewsOnDemand,
    assetUrl: row.AssetUrl,
    redirectUri: row.RedirectUrl ? row.RedirectUrl : null,
    documents,
    ministryKeys: keysOf("ministries"),
    sectorKeys: keysOf("sectors"),
    tagKeys: keysOf("tags"),
    themeKeys: keysOf("themes"),
    assets: null,
    translations: null,
    publishFlags: { toWeb: true, toSubscribers: isNewsOnDemand, toMediaLists: hasPublishOption(row.PublishOptions, PUBLISH_OPTIONS.MediaContacts) },
    mediaListKeys: [],
    renditions: null,
    timestamp: row.Timestamp.toISOString(),
  };
}
```

- [ ] **Step 4: Run mapper tests**

Run: `npx vitest run apps/news-api/src/import/map.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Write the failing runner test**

`apps/news-api/src/import/run.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createFakeSource } from "@gcpe/legacy-import";
import { createApp } from "../app";
import { createNewsTestDb, EVENT_SECRETS, TZ } from "../../test/helpers";
import { importLegacyNews } from "./run";

const RID = "9af8cc16-0ae5-4ec6-ad58-fdb081d44e37";
const source = createFakeSource({
  releaseYears: [{ Year: 2026 }],
  "releases:2026": [{
    Id: RID.toUpperCase(), Key: "2026TT0103-001121", ReleaseType: 1, Reference: "NEWS-34336", AtomId: "", PublishDateTime: new Date("2026-10-01T22:10:00Z"),
    LeadMinistryKey: "transportation-and-transit", Keywords: "", AssetUrl: "", RedirectUrl: "", HasMediaAssets: false, PublishOptions: 2,
    Timestamp: new Date("2026-10-01T22:10:28Z"), Location: "Abbotsford", Summary: "s", SocialMediaHeadline: null, SocialMediaSummary: null,
  }],
  "documents:2026": [{ ReleaseId: RID, DocumentId: "D1", SortIndex: 0, LanguageId: 4105, PageTitle: "News Release", Headline: "H", Subheadline: "", Byline: "", BodyHtml: "<p>b</p>" }],
  "contacts:2026": [],
  "releaseIndexes:2026": [{ ReleaseId: RID, IndexKind: "ministries", IndexKey: "transportation-and-transit" }],
  releaseKeysById: [{ Id: RID.toUpperCase(), Key: "2026TT0103-001121" }],
  appSettings: [{ SettingName: "HomeFeatureReleaseId", SettingValue: RID }, { SettingName: "granville", SettingValue: "off" }],
  categoryFeatures: [{ Kind: "ministries", Key: "transportation-and-transit", TopReleaseId: RID.toUpperCase(), FeatureReleaseId: null }],
  currentSlides: [{ Id: "F9ADFDC2-5933-4C38-A390-A18077ACB213", SortIndex: 0, Headline: "Get vaccinated", Summary: "s", ActionUrl: "https://x", Image: Buffer.from("89504e470d0a1a0a", "hex"), FacebookPostUrl: null, Justify: 1, Timestamp: new Date("2026-09-09T23:31:07Z") }],
  resourceLinks: [{ SortIndex: 0, LinkText: "Factsheets", LinkUrl: "/factsheets" }],
});

describe("importLegacyNews", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("imports posts and site content that the API then serves; re-running is idempotent", async () => {
    expect(await importLegacyNews(tdb.db, source)).toEqual({ releases: 1, slides: 1, resourceLinks: 1, features: 1 });
    expect(await importLegacyNews(tdb.db, source)).toEqual({ releases: 1, slides: 1, resourceLinks: 1, features: 1 });
    const app = createApp({ db: tdb.db, timeZone: TZ, eventSecrets: EVENT_SECRETS });
    const V = "api-version=1.0";
    expect((await request(app).get(`/api/Posts/2026TT0103-001121?${V}`)).body).toMatchObject({ publishDate: "2026-10-01T15:10:00-07:00", isNewsOnDemand: true });
    expect((await request(app).get(`/api/Home?${V}`)).body).toMatchObject({ featurePostKey: "2026TT0103-001121", topPostKey: null, granville: "off" });
    expect((await request(app).get(`/api/Slides?${V}`)).body[0]).toMatchObject({ justify: "right", imageType: "image/png", key: "f9adfdc2-5933-4c38-a390-a18077acb213" });
    const { rows } = await tdb.pool.query("SELECT count(*)::int AS n FROM posts");
    expect(rows[0].n).toBe(1);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run apps/news-api/src/import/run.test.ts`
Expected: FAIL — cannot resolve `./run`.

- [ ] **Step 7: Implement the runner and CLI**

`apps/news-api/src/import/run.ts`:
```ts
import type { Db } from "@gcpe/db-kit";
import type { CategoryKind } from "@gcpe/events";
import type { LegacySource } from "@gcpe/legacy-import";
import { applyRelease, applySiteContent } from "../projections";
import { imageTypeFromBytes, justifyFromLegacy, mapLegacyRelease, type LegacyContactRow, type LegacyDocumentRow, type LegacyIndexRow, type LegacyReleaseRow } from "./map";
import { Q_APP_SETTINGS, Q_CATEGORY_FEATURES, Q_CURRENT_SLIDES, Q_RELEASE_KEYS_BY_ID, Q_RELEASE_YEARS, Q_RESOURCE_LINKS, qContacts, qDocuments, qReleaseIndexes, qReleases } from "./queries";

const lower = (s: string) => s.toLowerCase();

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return m;
}

export async function importLegacyNews(db: Db, source: LegacySource, opts: { log?: (msg: string) => void } = {}) {
  const log = opts.log ?? (() => {});
  const result = { releases: 0, slides: 0, resourceLinks: 0, features: 0 };

  const years = (await source.query<{ Year: number }>(Q_RELEASE_YEARS)).map((r) => r.Year).sort();
  for (const y of years) {
    const releases = await source.query<LegacyReleaseRow>(qReleases(y));
    const docs = groupBy(await source.query<LegacyDocumentRow>(qDocuments(y)), (r) => lower(r.ReleaseId));
    const allContacts = await source.query<LegacyContactRow>(qContacts(y));
    const indexes = groupBy(await source.query<LegacyIndexRow>(qReleaseIndexes(y)), (r) => lower(r.ReleaseId));
    const contactsByDoc = groupBy(allContacts, (c) => lower(c.DocumentId));
    for (const row of releases) {
      const id = lower(row.Id);
      const releaseDocs = docs.get(id) ?? [];
      const contacts = releaseDocs.flatMap((d) => contactsByDoc.get(lower(d.DocumentId)) ?? []);
      const record = mapLegacyRelease(row, releaseDocs, contacts, indexes.get(id) ?? []);
      await db.transaction((tx) => applyRelease(tx, record));
      result.releases++;
    }
    log(`year ${y}: ${releases.length} releases`);
  }

  const keyById = new Map((await source.query<{ Id: string; Key: string }>(Q_RELEASE_KEYS_BY_ID)).map((r) => [lower(r.Id), r.Key]));
  const keyFor = (id: string | null | undefined) => (id ? (keyById.get(lower(id)) ?? null) : null);

  const settings = new Map((await source.query<{ SettingName: string; SettingValue: string }>(Q_APP_SETTINGS)).map((s) => [s.SettingName, s.SettingValue]));
  await db.transaction((tx) =>
    applySiteContent(tx, {
      entity: "home",
      topPostKey: keyFor(settings.get("HomeTopReleaseId")),
      featurePostKey: keyFor(settings.get("HomeFeatureReleaseId")),
      liveWebcastFlashMediaManifestUrl: null,
      liveWebcastM3uPlaylist: null,
      granville: settings.get("granville") ?? null,
      timestamp: new Date().toISOString(),
    }),
  );

  for (const f of await source.query<{ Kind: CategoryKind; Key: string; TopReleaseId: string | null; FeatureReleaseId: string | null }>(Q_CATEGORY_FEATURES)) {
    await db.transaction((tx) =>
      applySiteContent(tx, { entity: "categoryFeatures", kind: f.Kind, key: f.Key, topPostKey: keyFor(f.TopReleaseId), featurePostKey: keyFor(f.FeatureReleaseId) }),
    );
    result.features++;
  }

  const slideRows = await source.query<{ Id: string; SortIndex: number; Headline: string | null; Summary: string | null; ActionUrl: string | null; Image: Buffer | null; FacebookPostUrl: string | null; Justify: number | null; Timestamp: Date }>(Q_CURRENT_SLIDES);
  await db.transaction((tx) =>
    applySiteContent(tx, {
      entity: "slides",
      slides: slideRows.map((s) => ({
        id: lower(s.Id),
        sortIndex: s.SortIndex,
        headline: s.Headline,
        summary: s.Summary,
        actionLabel: null,
        actionUri: s.ActionUrl,
        imageBase64: s.Image ? s.Image.toString("base64") : null,
        imageType: imageTypeFromBytes(s.Image),
        facebookPostUri: s.FacebookPostUrl,
        justify: justifyFromLegacy(s.Justify),
        timestamp: s.Timestamp.toISOString(),
      })),
    }),
  );
  result.slides = slideRows.length;

  const links = await source.query<{ SortIndex: number; LinkText: string; LinkUrl: string }>(Q_RESOURCE_LINKS);
  await db.transaction((tx) =>
    applySiteContent(tx, {
      entity: "resourceLinks",
      links: links.map((l) => ({ sortIndex: l.SortIndex, text: l.LinkText, uri: l.LinkUrl })),
      timestamp: new Date().toISOString(),
    }),
  );
  result.resourceLinks = links.length;
  return result;
}
```

`apps/news-api/src/import/cli.ts`:
```ts
import { z } from "zod";
import { parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { createMssqlSource } from "@gcpe/legacy-import";
import { importLegacyNews } from "./run";

const env = parseEnv(
  z.object({
    DATABASE_URL: z.string().url(),
    LEGACY_SQL_SERVER: z.string().min(1),
    LEGACY_SQL_DATABASE: z.string().default("Gcpe.Hub"),
    LEGACY_SQL_USER: z.string().min(1),
    LEGACY_SQL_PASSWORD: z.string().min(1),
    LEGACY_SQL_TRUST_CERT: z.enum(["true", "false"]).default("false"),
  }),
);

const { db, pool } = createDb(env.DATABASE_URL);
await runMigrations(db, new URL("../../migrations", import.meta.url).pathname);
const source = await createMssqlSource({
  server: env.LEGACY_SQL_SERVER,
  database: env.LEGACY_SQL_DATABASE,
  user: env.LEGACY_SQL_USER,
  password: env.LEGACY_SQL_PASSWORD,
  trustServerCertificate: env.LEGACY_SQL_TRUST_CERT === "true",
});
try {
  console.log(JSON.stringify(await importLegacyNews(db, source, { log: console.log }), null, 2));
} finally {
  await source.close();
  await pool.end();
}
```

- [ ] **Step 8: Run tests**

Run: `npx vitest run apps/news-api && npm run check`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/news-api
git commit -m "feat(news-api): idempotent legacy importer for posts and site content"
```

---

### Task 12: Runtime wiring, container, docs

**Files:**
- Create: `apps/news-api/src/main.ts`, `apps/news-api/Dockerfile`
- Modify: `README.md`

**Interfaces:**
- Consumes: `createApp`, `createUpdatesHub`, `listenForUpdates`, `createClientCredentialsProvider`, `loadTenantConfig`.
- Env: `DATABASE_URL`, `PORT` (default 3002), `TENANT_CONFIG` (default `config/tenants/bc.json`), `EVENT_SECRETS` (JSON object source→secret, e.g. `{"core":"…","nrms":"…"}`), optional `NOD_BASE_URL`, `NOD_TOKEN_URL`, `NOD_CLIENT_ID`, `NOD_CLIENT_SECRET`, `NOD_SCOPE`, `SUBSCRIBE_RATE_LIMIT_PER_MIN` (default 300), `MIGRATIONS_FOLDER`.

- [ ] **Step 1: Write `main.ts`**

`apps/news-api/src/main.ts`:
```ts
import { createServer } from "node:http";
import { z } from "zod";
import { createClientCredentialsProvider } from "@gcpe/auth";
import { loadTenantConfig, parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { createApp } from "./app";
import { createUpdatesHub } from "./updates/hub";
import { listenForUpdates } from "./updates/notify";

const env = parseEnv(
  z.object({
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().default(3002),
    TENANT_CONFIG: z.string().default(new URL("../../../config/tenants/bc.json", import.meta.url).pathname),
    EVENT_SECRETS: z.string().default("{}"),
    NOD_BASE_URL: z.string().url().optional(),
    NOD_TOKEN_URL: z.string().url().optional(),
    NOD_CLIENT_ID: z.string().optional(),
    NOD_CLIENT_SECRET: z.string().optional(),
    NOD_SCOPE: z.string().optional(),
    SUBSCRIBE_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(300),
    MIGRATIONS_FOLDER: z.string().default(new URL("../migrations", import.meta.url).pathname),
  }),
);

const tenant = loadTenantConfig(env.TENANT_CONFIG);
const { db, pool } = createDb(env.DATABASE_URL);
await runMigrations(db, env.MIGRATIONS_FOLDER);

const getToken =
  env.NOD_TOKEN_URL && env.NOD_CLIENT_ID && env.NOD_CLIENT_SECRET && env.NOD_SCOPE
    ? createClientCredentialsProvider({ tokenUrl: env.NOD_TOKEN_URL, clientId: env.NOD_CLIENT_ID, clientSecret: env.NOD_CLIENT_SECRET, scope: env.NOD_SCOPE })
    : undefined;

const hub = createUpdatesHub();
const app = createApp({
  db,
  timeZone: tenant.timeZone,
  eventSecrets: z.record(z.string()).parse(JSON.parse(env.EVENT_SECRETS)),
  hubRouter: hub.router,
  subscribe: env.NOD_BASE_URL ? { baseUrl: env.NOD_BASE_URL, getToken, rateLimitPerMinute: env.SUBSCRIBE_RATE_LIMIT_PER_MIN } : undefined,
});
const server = createServer(app);
hub.attach(server);
const stopListening = await listenForUpdates(pool, (target, keys) => hub.broadcast(target, keys));
server.listen(env.PORT, () => console.log(`[news-api] listening on ${env.PORT} (${tenant.tenantId}, ${tenant.timeZone})`));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    hub.close();
    server.close();
    await stopListening();
    await pool.end();
    process.exit(0);
  });
}
```

- [ ] **Step 2: Smoke-run locally against the fixture world**

```bash
createdb news_api_dev
DATABASE_URL=postgres://localhost:5432/news_api_dev npm --workspace @gcpe/news-api run seed:fixtures
DATABASE_URL=postgres://localhost:5432/news_api_dev EVENT_SECRETS='{}' npm --workspace @gcpe/news-api run dev &
sleep 3
curl -s "http://localhost:3002/api/Home?api-version=1.0"
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3002/api/Home"
curl -s -X POST "http://localhost:3002/updates/negotiate?negotiateVersion=1"
kill %1
```
Expected: the home JSON (with `topPostKey`/`featurePostKey` from the fixture), `400`, and a negotiate JSON containing `"transport":"WebSockets"`.

- [ ] **Step 3: Dockerfile and build**

`apps/news-api/Dockerfile` (build context = repo root):
```dockerfile
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/news-api ./apps/news-api
COPY scripts ./scripts
COPY config ./config
RUN npm ci --workspace @gcpe/news-api --include-workspace-root
RUN node scripts/build-app.mjs apps/news-api

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/package.json /repo/package-lock.json ./
COPY --from=build /repo/apps/news-api/package.json ./apps/news-api/package.json
COPY --from=build /repo/packages ./packages
RUN npm ci --omit=dev --workspace @gcpe/news-api
COPY --from=build /repo/apps/news-api/dist ./apps/news-api/dist
COPY --from=build /repo/apps/news-api/migrations ./apps/news-api/migrations
COPY --from=build /repo/config ./config
USER 1001
ENV MIGRATIONS_FOLDER=/app/apps/news-api/migrations TENANT_CONFIG=/app/config/tenants/bc.json
EXPOSE 3002
HEALTHCHECK CMD wget -qO- http://localhost:3002/health/live || exit 1
CMD ["node", "apps/news-api/dist/main.js"]
```

Run: `npm --workspace @gcpe/news-api run build && ls apps/news-api/dist/main.js`
Expected: file exists.

- [ ] **Step 4: README section**

Append to `README.md`:
````markdown
## News API (`apps/news-api`)

Drop-in replacement for the BC Gov News API v1 (minus newsletters), including the SignalR `/updates` hub used by `gcpe-news-webapp`.

```bash
createdb news_api_dev
DATABASE_URL=postgres://localhost:5432/news_api_dev npm --workspace @gcpe/news-api run seed:fixtures   # recorded live data
DATABASE_URL=postgres://localhost:5432/news_api_dev EVENT_SECRETS='{"core":"dev","nrms":"dev"}' npm --workspace @gcpe/news-api run dev
curl "http://localhost:3002/api/Posts/Latest/home/default?count=3&api-version=1.0"
```

- Re-record live fixtures: `npm --workspace @gcpe/news-api run record:fixtures` (public read-only GETs, 1 req/s). The compatibility suite (`apps/news-api/test/compat.test.ts`) must stay green.
- Legacy import: `DATABASE_URL=… LEGACY_SQL_SERVER=… LEGACY_SQL_USER=… LEGACY_SQL_PASSWORD=… npm --workspace @gcpe/news-api run import:legacy`
- Core reference data reaches the News API as events: configure Core's `EVENT_SUBSCRIBERS` with `{"name":"news-api","url":"http://<news-api>/events","secret":"<same as EVENT_SECRETS.core>","types":["*"]}` and call Core's `POST /api/admin/republish` once.

### Manual check with the existing .NET public site

Requires the .NET 5 SDK. This is not automated.

1. `git clone https://github.com/bcgov/gcpe-news-webapp && cd gcpe-news-webapp/Gov.News.WebApp`
2. Set `NewsApi` to `http://localhost:3002/` in `appsettings.Development.json` and run `dotnet run`.
3. Open the home page, a release page, and a ministry page. Confirm they render, and that the log shows `SignalR Client Started`.
````

- [ ] **Step 5: Full verification and commit**

Run: `npm run check && npm test`
Expected: all green.

```bash
git add apps/news-api README.md
git commit -m "feat(news-api): runtime wiring, container, and docs"
```

---

## Phase 1 exit check

1. `npm run check && npm test`: all green, including `apps/news-api/test/compat.test.ts`. This is spec success criterion 2 against recorded responses.
2. Manual: `gcpe-news-webapp` renders home, release and ministry pages against the local News API, and connects to the SignalR hub (README steps). This is spec success criterion 3.
3. **Rehearsal (needs a legacy DB copy; resolves Review Focus #1):**
   - Run Core `import:legacy`, then republish to the News API, then run News API `import:legacy`.
   - Diff `GET /api/Ministries`, `/api/Posts/Latest/home/default?count=20` and `/api/Slides` against `api.news.gov.bc.ca`, using `normalize()` from `apps/news-api/test/normalize.ts`.
   - Record every field mismatch and fix its mapping rule.
