import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { sampleRelease } from "@gcpe/events/testing";
import { createApp } from "../app";
import { applyOrg, applyRelease } from "../projections";
import { listenForUpdates, type UpdateTarget } from "../updates/notify";
import { createNewsTestDb, EVENT_SECRETS, TZ } from "../../test/helpers";
import { createPublicApiClient, fetchPublicSlice, PUBLIC_IMPORT_USER_AGENT, RateLimitedError } from "./public-fetch";
import { parsePublicImportArgs, type PublicImportCliOptions } from "./public-options";
import { runPublicImport } from "./public-run";
import { absoluteFileKey } from "./public-files";

const FILES = "https://bcgovnews-etg7c8etapa6btfr.z03.azurefd.net";

// ---------------------------------------------------------------- the stub legacy API

type Dto = Record<string, unknown> & { key: string; kind: string; ministryKeys: string[]; sectorKeys: string[]; themeKeys: string[]; tagKeys: string[] };

function dto(key: string, kind: string, day: number, cats: Partial<Pick<Dto, "ministryKeys" | "sectorKeys" | "themeKeys" | "tagKeys">> = {}, timestamp?: string): Dto {
  const d = String(day).padStart(2, "0");
  return {
    kind, atomId: `uuid:${key}`, summary: `Summary of ${key}`, socialMediaSummary: null, socialMediaHeadline: null, keywords: "",
    publishDate: `2026-10-${d}T10:00:00-07:00`, leadMinistryKey: cats.ministryKeys?.[0] ?? null, hasMediaAssets: false, hasTranslations: false,
    isNewsOnDemand: true, assetUrl: "https://www.flickr.com/photos/bcgovphotos/", location: "Victoria",
    documents: [{ pageTitle: "News Release", languageId: 4105, headline: `Headline ${key}`, subheadline: "", detailsHtml: "<p>Body</p>", byline: "", contacts: [{ title: "Ministry", details: "Media Relations\n250-555-0100" }] }],
    reference: kind === "releases" ? `NEWS-${day}` : null, redirectUri: null,
    ministryKeys: [], sectorKeys: [], themeKeys: [], tagKeys: [], ...cats,
    azureAssets: null, azureTranslations: null, key, timestamp: timestamp ?? `2026-10-${d}T10:00:28.0375661-07:00`,
  };
}

const POSTS: Dto[] = [
  dto("2026HLTH0001-000001", "releases", 1, { ministryKeys: ["health"], sectorKeys: ["economy"] }),
  dto("2026HLTH0002-000002", "releases", 2, { ministryKeys: ["health", "zz-retired-ministry"], tagKeys: ["zz-unlisted-tag"] }),
  dto("health-story", "stories", 3, { ministryKeys: ["health"], themeKeys: ["wellness"] }),
  dto("mining-factsheet", "factsheets", 4, { ministryKeys: ["mining"], sectorKeys: ["economy"] }),
  {
    ...dto("rural-update", "updates", 5, { ministryKeys: ["mining"], tagKeys: ["rural"] }),
    hasTranslations: true, hasMediaAssets: true,
    azureTranslations: [{ key: "updates/rural-update/Flyer_Chinese(simplified).pdf", label: "Chinese(Simplified)", length: 10 }],
    azureAssets: [{ key: "updates/rural-update/photo one.jpg", label: "Photo", length: 20 }, { key: "https://elsewhere.example/a.jpg", label: "Abs", length: 5 }],
  },
  dto("only-by-key", "stories", 6, { ministryKeys: ["mining"] }),
];

interface Stub {
  base: string;
  log: { path: string; ua: string | undefined }[];
  /** Status to answer for the next N requests whose path includes the key, before answering normally. */
  failNext: { match: string; status: number; times: number }[];
  close: () => Promise<void>;
}

async function startStub(posts: Dto[] = POSTS): Promise<Stub> {
  const log: Stub["log"] = [];
  const failNext: Stub["failNext"] = [];
  const lists: Record<string, string[]> = { Ministries: ["health", "mining"], Sectors: ["economy"], Themes: ["wellness"], Tags: ["rural"] };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, "http://stub");
    log.push({ path: url.pathname + url.search, ua: req.headers["user-agent"] });
    const fail = failNext.find((f) => f.times > 0 && url.pathname.includes(f.match));
    if (fail) {
      fail.times--;
      res.writeHead(fail.status).end();
      return;
    }
    const json = (body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    const parts = url.pathname.split("/").filter(Boolean); // api, Posts, Latest, kind, key
    const count = Number(url.searchParams.get("count") ?? "100");
    const newest = (list: Dto[]) => [...list].sort((a, b) => String(b.publishDate).localeCompare(String(a.publishDate))).slice(0, count);
    if (parts[1] && parts.length === 2 && lists[parts[1]]) return json(lists[parts[1]]!.map((key) => ({ key, name: key, isActive: true })));
    if (parts[1] === "Posts" && parts[2] === "Latest" && parts[3] === "home") {
      const kind = url.searchParams.get("postKind") ?? "default";
      return json(newest(posts.filter((p) => (kind === "default" ? ["releases", "stories"].includes(p.kind) : p.kind === kind) && p.key !== "only-by-key")));
    }
    if (parts[1] === "Posts" && parts[2] === "Latest") {
      const field = ({ ministries: "ministryKeys", sectors: "sectorKeys", themes: "themeKeys", tags: "tagKeys" } as const)[parts[3] as "ministries"];
      const key = decodeURIComponent(parts[4]!);
      return json(newest(posts.filter((p) => ["releases", "stories"].includes(p.kind) && p[field].includes(key) && p.key !== "only-by-key")));
    }
    if (parts[1] === "Posts" && parts.length === 2) {
      const keys = (url.searchParams.get("postKeys") ?? "").split(",").map((k) => k.toLowerCase());
      return json(posts.filter((p) => keys.includes(p.key.toLowerCase())));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, log, failNext, close: () => new Promise((r) => server.close(() => r())) };
}

const options = (over: Partial<PublicImportCliOptions> = {}): PublicImportCliOptions => ({
  from: "", perKind: 20, perCategory: 3, keys: [], maxRequests: 300, dryRun: false, remove: false, refresh: false, filesBase: FILES, ...over,
});
const fastClient = (base: string) => createPublicApiClient({ base, minIntervalMs: 0 });

// ---------------------------------------------------------------- options

describe("absoluteFileKey", () => {
  it("builds the news.gov translation URL from a relative key (parentheses, spaces, non-ASCII encoded per segment)", () => {
    expect(absoluteFileKey("releases/2026HLTH0085-001117/RSVVaccine2026_Chinese(simplified).pdf", "translations", FILES)).toBe(
      `${FILES}/translations/releases/2026HLTH0085-001117/RSVVaccine2026_Chinese%28simplified%29.pdf`,
    );
    expect(absoluteFileKey("releases/K/a b#c?d.pdf", "translations", FILES)).toBe(`${FILES}/translations/releases/K/a%20b%23c%3Fd.pdf`);
    expect(absoluteFileKey("releases/K/简体 中文.pdf", "translations", FILES + "/")).toBe(`${FILES}/translations/releases/K/${encodeURIComponent("简体 中文")}.pdf`);
  });
  it("uses /assets/ for media assets", () => {
    expect(absoluteFileKey("stories/K/photo.jpg", "assets", FILES)).toBe(`${FILES}/assets/stories/K/photo.jpg`);
  });
  it("passes absolute https keys through unchanged and rejects anything else", () => {
    expect(absoluteFileKey("https://x.example/a%20b(1).pdf", "translations", FILES)).toBe("https://x.example/a%20b(1).pdf");
    for (const bad of ["http://x.example/a.pdf", "javascript:alert(1)", "//x.example/a.pdf", "a/../b.pdf", "a//b.pdf", ""]) {
      expect(() => absoluteFileKey(bad, "assets", FILES), bad).toThrow(/unsupported/);
    }
  });
});

describe("parsePublicImportArgs", () => {
  it("has the documented defaults", () => {
    expect(parsePublicImportArgs([])).toEqual({ from: "https://api.news.gov.bc.ca", perKind: 20, perCategory: 3, keys: [], maxRequests: 300, dryRun: false, remove: false, refresh: false, filesBase: "https://bcgovnews-etg7c8etapa6btfr.z03.azurefd.net" });
  });
  it("parses every option, in both --flag value and --flag=value forms", () => {
    expect(parsePublicImportArgs(["--from", "http://x/", "--per-kind=2", "--per-category", "0", "--keys", "a, b", "--keys=c", "--max-requests", "50", "--dry-run", "--refresh", "--files-base", "https://files.example/"])).toEqual({
      from: "http://x", perKind: 2, perCategory: 0, keys: ["a", "b", "c"], maxRequests: 50, dryRun: true, remove: false, refresh: true, filesBase: "https://files.example",
    });
    expect(() => parsePublicImportArgs(["--files-base", "http://files.example"])).toThrow(/https/);
    expect(() => parsePublicImportArgs(["--remove", "--refresh"])).toThrow(/--remove takes no fetch options/);
    expect(parsePublicImportArgs(["--remove", "--dry-run"])).toMatchObject({ remove: true, dryRun: true });
  });
  it("rejects unknown arguments, bad numbers and fetch options with --remove", () => {
    expect(() => parsePublicImportArgs(["--per-kinds", "3"])).toThrow(/Unknown argument/);
    expect(() => parsePublicImportArgs(["--per-kind", "-1"])).toThrow(/whole number/);
    expect(() => parsePublicImportArgs(["--keys"])).toThrow(/needs a value/);
    expect(() => parsePublicImportArgs(["--remove", "--keys", "a"])).toThrow(/--remove takes no fetch options/);
    expect(() => parsePublicImportArgs(["--from", "ftp://x"])).toThrow(/http/);
  });
});

// ---------------------------------------------------------------- the client's politeness

describe("createPublicApiClient", () => {
  let stub: Stub;
  beforeEach(async () => {
    stub = await startStub();
  });
  afterEach(async () => {
    await stub.close();
  });

  it("sends the import User-Agent and spaces requests at least minIntervalMs apart", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const client = createPublicApiClient({ base: stub.base, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
    await client.get("/api/Sectors?api-version=1.0");
    clock += 300;
    await client.get("/api/Themes?api-version=1.0");
    await client.get("/api/Tags?api-version=1.0");
    expect(sleeps).toEqual([700, 1000]);
    expect(client.requests).toBe(3);
    expect(stub.log.every((l) => l.ua === PUBLIC_IMPORT_USER_AGENT)).toBe(true);
  });

  it("retries a 5xx exactly once", async () => {
    stub.failNext.push({ match: "Sectors", status: 503, times: 1 });
    const client = fastClient(stub.base);
    expect((await client.get("/api/Sectors")).body).toEqual([{ key: "economy", name: "economy", isActive: true }]);
    stub.failNext.push({ match: "Themes", status: 502, times: 5 });
    expect(await client.get("/api/Themes")).toEqual({ status: 502, body: null });
    expect(client.requests).toBe(4);
  });

  it("stops on a 429 without retrying", async () => {
    stub.failNext.push({ match: "Tags", status: 429, times: 5 });
    const client = fastClient(stub.base);
    await expect(client.get("/api/Tags")).rejects.toBeInstanceOf(RateLimitedError);
    expect(client.requests).toBe(1);
  });
});

// ---------------------------------------------------------------- the fetch plan

describe("fetchPublicSlice", () => {
  let stub: Stub;
  beforeAll(async () => {
    stub = await startStub();
  });
  afterAll(async () => {
    await stub.close();
  });

  it("fetches each post kind, each listed category and the extra keys, and reports what it found", async () => {
    stub.log.length = 0;
    const logs: string[] = [];
    const slice = await fetchPublicSlice(fastClient(stub.base), { perKind: 20, perCategory: 3, keys: ["only-by-key", "ZZ-missing", "health-story"], maxRequests: 300, log: (m) => logs.push(m) });
    // 4 post kinds + 4 category lists + 5 categories (health, mining, economy, wellness, rural) + 1 key batch.
    expect(slice.plan).toEqual({ kindRequests: 4, listRequests: 4, categoryRequests: 5, keyRequests: 1, total: 14, categoriesSkippedByCap: [] });
    expect(slice.requests).toBe(14);
    expect(stub.log).toHaveLength(14);
    expect(logs.some((l) => l.includes("14 request(s) in all"))).toBe(true);
    expect(slice.perKind).toEqual({ releases: 2, stories: 1, factsheets: 1, updates: 1 });
    expect(slice.perCategory).toEqual({ "ministries:health": 3, "ministries:mining": 0, "sectors:economy": 1, "themes:wellness": 1, "tags:rural": 0 });
    expect(slice.records.map((r) => r.key).sort()).toEqual(POSTS.map((p) => p.key).sort());
    expect(slice.uniqueByKind).toEqual({ releases: 2, stories: 2, factsheets: 1, updates: 1 });
    expect(slice.keysNotFound).toEqual(["ZZ-missing"]);
    expect(slice.notListedBySource).toEqual({ ministries: { "zz-retired-ministry": 1 }, tags: { "zz-unlisted-tag": 1 } });
    expect(slice.records.every((r) => r.publishFlags.toSubscribers === false && r.publishFlags.toMediaLists === false)).toBe(true);
  });

  it("makes relative translation and asset keys absolute, honouring --files-base; a bad key invalidates only its post", async () => {
    const rural = (await fetchPublicSlice(fastClient(stub.base), { perKind: 0, perCategory: 0, keys: ["rural-update"], maxRequests: 10 })).records[0]!;
    expect(rural.translations).toEqual([{ key: `${FILES}/translations/updates/rural-update/Flyer_Chinese%28simplified%29.pdf`, label: "Chinese(Simplified)", length: 10 }]);
    expect(rural.assets!.map((a) => a.key)).toEqual([`${FILES}/assets/updates/rural-update/photo%20one.jpg`, "https://elsewhere.example/a.jpg"]);
    const other = (await fetchPublicSlice(fastClient(stub.base), { perKind: 0, perCategory: 0, keys: ["rural-update"], maxRequests: 10, filesBase: "https://cdn.example/f/" })).records[0]!;
    expect(other.translations![0]!.key).toBe("https://cdn.example/f/translations/updates/rural-update/Flyer_Chinese%28simplified%29.pdf");
    const bad = await startStub([{ ...POSTS[0]!, azureTranslations: [{ key: "ftp://x/y.pdf", label: "L", length: 1 }] }, POSTS[2]!]);
    try {
      const slice = await fetchPublicSlice(fastClient(bad.base), { perKind: 0, perCategory: 0, keys: [POSTS[0]!.key, POSTS[2]!.key], maxRequests: 10 });
      expect(slice.records.map((r) => r.key)).toEqual([POSTS[2]!.key]);
      expect(slice.invalid).toEqual([{ key: POSTS[0]!.key, issue: expect.stringMatching(/unsupported translations key/) }]);
    } finally {
      await bad.close();
    }
  });

  it("drops categories, taking turns across kinds, to stay within --max-requests", async () => {
    const slice = await fetchPublicSlice(fastClient(stub.base), { perKind: 1, perCategory: 1, keys: [], maxRequests: 10, log: () => {} });
    expect(slice.plan.total).toBe(10);
    expect(slice.plan.categoryRequests).toBe(2);
    expect(slice.plan.categoriesSkippedByCap).toEqual(["themes:wellness", "tags:rural", "ministries:mining"]);
  });

  it("skips post kinds and categories when their counts are 0", async () => {
    const slice = await fetchPublicSlice(fastClient(stub.base), { perKind: 0, perCategory: 0, keys: ["rural-update"], maxRequests: 300 });
    expect(slice.plan.total).toBe(1);
    expect(slice.records.map((r) => r.key)).toEqual(["rural-update"]);
  });
});

// ---------------------------------------------------------------- the write path

/** Rows in every table of the public schema: the no-side-effects check compares these. */
async function tableCounts(tdb: TestDatabase): Promise<Record<string, number>> {
  const { rows } = await tdb.db.execute<{ t: string }>(sql`select tablename as t from pg_tables where schemaname = 'public' order by 1`);
  const out: Record<string, number> = {};
  for (const { t } of rows) {
    const r = await tdb.db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from "${t}"`));
    out[t] = r.rows[0]!.n;
  }
  return out;
}
const changed = (a: Record<string, number>, b: Record<string, number>) => Object.keys(b).filter((t) => a[t] !== b[t]).sort();
const changeRows = async (tdb: TestDatabase) =>
  (await tdb.db.execute<{ kind: string; key: string }>(sql`select kind, key from changes order by id`)).rows.map((r) => `${r.kind} ${r.key}`);

describe("runPublicImport against a News API database", () => {
  let tdb: TestDatabase;
  let stub: Stub;
  const notifications: { target: UpdateTarget; keys: string[] }[] = [];
  let stopListening: () => Promise<void>;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
    stub = await startStub();
    // Only ministry "health" is known to the target; everything else is an unknown category.
    await tdb.db.transaction((tx) =>
      applyOrg(tx, {
        key: "health", displayName: "Health", abbreviation: null, sortOrder: 0, isActive: true, parentKey: null, url: null, displayAdditionalName: null,
        minister: { name: null, summary: null, detailsHtml: null, email: null, photoUrl: null, address: null }, contact: null, secondContact: null,
        weekendContactNumber: null, social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null }, topicLinks: [], serviceLinks: [],
        sectorKeys: [], isHq: false, isPublic: true, successorKeys: [], updatedAt: "2026-10-01T00:00:00Z",
      }),
    );
    // An NRMS-published post and a legacy-imported post that the slice also contains.
    await tdb.db.transaction((tx) => applyRelease(tx, { ...sampleRelease, key: "2026HLTH0001-000001", summary: "NRMS copy" }));
    await tdb.db.transaction((tx) => applyRelease(tx, { ...sampleRelease, key: "MINING-FACTSHEET", kind: "factsheets", summary: "legacy copy" }, { notify: false, origin: "legacy" }));
    const listener = await listenForUpdates(tdb.pool, (target, keys) => notifications.push({ target, keys }));
    stopListening = listener.stop;
  });
  afterAll(async () => {
    await stopListening();
    await stub.close();
    await tdb.drop();
  });

  const run = (over: Partial<PublicImportCliOptions> = {}, db: TestDatabase["db"] | null = tdb.db) =>
    runPublicImport({ db, client: fastClient(stub.base) }, options({ keys: ["only-by-key", "zz-missing"], ...over }));

  it("a dry run reports what it would do and writes nothing", async () => {
    const before = await tableCounts(tdb);
    const report = await run({ dryRun: true });
    expect(report.mode).toBe("dry-run");
    expect(report.write).toMatchObject({ created: 4, updated: 0, unchanged: 0, skippedExisting: ["2026HLTH0001-000001", "mining-factsheet"] });
    expect(changed(before, await tableCounts(tdb))).toEqual([]);
    // Without a database: fetch only.
    expect((await run({ dryRun: true }, null)).write).toBeUndefined();
  });

  it("imports through the legacy write path, skips posts it didn't create, records changes and nothing else", async () => {
    const before = await tableCounts(tdb);
    const changesBefore = (await changeRows(tdb)).length;
    notifications.length = 0;
    const report = await run();
    expect(report.write).toEqual({
      created: 4, updated: 0, unchanged: 0, skippedExisting: ["2026HLTH0001-000001", "mining-factsheet"], skippedEventOwned: [],
      unknownCategoryKeys: {
        ministries: { "zz-retired-ministry": 1, mining: 3 },
        sectors: { economy: 2 },
        themes: { wellness: 1 },
        tags: { "zz-unlisted-tag": 1, rural: 1 },
      },
    });
    expect(report.fetch!.keysNotFound).toEqual(["zz-missing"]);

    // Only posts, the tracking table and the change feed changed: no outbox_events/outbox_deliveries
    // (no site.rebuild_requested doorbell, nothing NRMS, NoD or distribution could receive), no inbox rows.
    expect(changed(before, await tableCounts(tdb))).toEqual(["changes", "posts", "public_import_posts"]);
    const counts = await tableCounts(tdb);
    expect(counts).toMatchObject({ outbox_events: 0, outbox_deliveries: 0, inbox_events: 0 });
    // No PostUpdate NOTIFY either (as the legacy importer: notify false).
    await new Promise((r) => setTimeout(r, 200));
    expect(notifications).toEqual([]);

    // In fetch order: the post kinds (newest first), then the extra keys.
    const imported = ["2026HLTH0002-000002", "health-story", "rural-update", "only-by-key"];
    expect((await changeRows(tdb)).slice(changesBefore)).toEqual(imported.map((k) => `post.upserted ${k}`));
    const rows = (await tdb.db.execute<{ key: string; origin: string; index_keys: string[]; is_published: boolean }>(sql`select key, origin, index_keys, is_published from posts order by key`)).rows;
    expect(rows.filter((r) => imported.includes(r.key)).every((r) => r.origin === "legacy" && r.is_published)).toBe(true);
    // Unknown category keys are stored as given.
    expect(rows.find((r) => r.key === "2026HLTH0002-000002")!.index_keys).toEqual(["ministries:health", "ministries:zz-retired-ministry", "tags:zz-unlisted-tag"]);
    // The skipped posts are untouched.
    const kept = (await tdb.db.execute<{ key: string; summary: string; origin: string }>(sql`select key, summary, origin from posts where key in ('2026HLTH0001-000001', 'MINING-FACTSHEET') order by key`)).rows;
    expect(kept).toEqual([{ key: "2026HLTH0001-000001", summary: "NRMS copy", origin: "event" }, { key: "MINING-FACTSHEET", summary: "legacy copy", origin: "legacy" }]);
  });

  it("the API serves an imported post exactly as the source gave it, and lists it under the known ministry", async () => {
    const app = createApp({ db: tdb.db, timeZone: TZ, eventSecrets: EVENT_SECRETS });
    const res = await request(app).get("/api/Posts/2026HLTH0002-000002?api-version=1.0");
    const source = POSTS.find((p) => p.key === "2026HLTH0002-000002")!;
    expect(res.body).toEqual({ ...source, timestamp: "2026-10-02T10:00:28.037-07:00" });
    const latest = await request(app).get("/api/Posts/Latest/ministries/health?api-version=1.0");
    expect(latest.body.map((p: { key: string }) => p.key)).toContain("2026HLTH0002-000002");
    // An unknown category is not a category: its index answers 404, the post is simply not listed there.
    expect((await request(app).get("/api/Posts/Latest/ministries/zz-retired-ministry?api-version=1.0")).status).toBe(404);
  });

  it("a re-run is idempotent: nothing written, no change rows", async () => {
    const before = await tableCounts(tdb);
    const report = await run();
    expect(report.write).toMatchObject({ created: 0, updated: 0, unchanged: 4, skippedExisting: ["2026HLTH0001-000001", "mining-factsheet"] });
    expect(changed(before, await tableCounts(tdb))).toEqual([]);
  });

  it("the API serves imported translations and assets as absolute URLs", async () => {
    const app = createApp({ db: tdb.db, timeZone: TZ, eventSecrets: EVENT_SECRETS });
    const res = await request(app).get("/api/Posts/rural-update?api-version=1.0");
    expect(res.body.azureTranslations[0].key).toBe(`${FILES}/translations/updates/rural-update/Flyer_Chinese%28simplified%29.pdf`);
    expect(res.body.azureAssets.map((a: { key: string }) => a.key)).toEqual([`${FILES}/assets/updates/rural-update/photo%20one.jpg`, "https://elsewhere.example/a.jpg"]);
  });

  it("--refresh rewrites posts it created even with an unchanged timestamp, and still never touches others", async () => {
    const changed1 = await startStub(POSTS.map((p) => (p.key === "rural-update" ? { ...p, summary: "same timestamp, new text" } : p)));
    const summary = async () => (await tdb.db.execute<{ summary: string }>(sql`select summary from posts where key = 'rural-update'`)).rows[0]!.summary;
    try {
      const mk = (refresh: boolean) => runPublicImport({ db: tdb.db, client: fastClient(changed1.base) }, options({ keys: ["only-by-key"], refresh }));
      expect((await mk(false)).write).toMatchObject({ updated: 0, unchanged: 4 });
      expect(await summary()).toBe("Summary of rural-update");
      const before = (await changeRows(tdb)).length;
      const planned = await runPublicImport({ db: tdb.db, client: fastClient(changed1.base) }, options({ keys: ["only-by-key"], refresh: true, dryRun: true }));
      expect(planned.write).toMatchObject({ updated: 4, unchanged: 0, skippedExisting: ["2026HLTH0001-000001", "mining-factsheet"] });
      expect((await changeRows(tdb)).length).toBe(before);
      const report = await mk(true);
      expect(report.write).toMatchObject({ created: 0, updated: 4, unchanged: 0, skippedExisting: ["2026HLTH0001-000001", "mining-factsheet"] });
      expect(await summary()).toBe("same timestamp, new text");
    } finally {
      await changed1.close();
    }
    // Put it back so later tests see the source's text.
    await runPublicImport({ db: tdb.db, client: fastClient(stub.base) }, options({ keys: ["only-by-key"], refresh: true }));
    expect(await summary()).toBe("Summary of rural-update");
    const kept = (await tdb.db.execute<{ summary: string }>(sql`select summary from posts where key in ('2026HLTH0001-000001', 'MINING-FACTSHEET') order by key`)).rows.map((r) => r.summary);
    expect(kept).toEqual(["NRMS copy", "legacy copy"]);
  });

  it("a post the source has edited since is updated, and leaves no post it took over from NRMS", async () => {
    const edited = await startStub(POSTS.map((p) => (p.key === "rural-update" ? { ...p, summary: "edited", timestamp: "2026-10-09T10:00:00-07:00" } : p)));
    // NRMS has since published one of ours.
    await tdb.db.transaction((tx) => applyRelease(tx, { ...sampleRelease, key: "health-story", kind: "stories", summary: "NRMS took over" }));
    const changesBefore = (await changeRows(tdb)).length;
    try {
      const report = await runPublicImport({ db: tdb.db, client: fastClient(edited.base) }, options({ keys: ["only-by-key"] }));
      expect(report.write).toMatchObject({ created: 0, updated: 1, unchanged: 2, skippedEventOwned: ["health-story"] });
    } finally {
      await edited.close();
    }
    expect((await changeRows(tdb)).slice(changesBefore)).toEqual(["post.upserted rural-update"]);
    expect((await tdb.db.execute<{ summary: string }>(sql`select summary from posts where key = 'health-story'`)).rows[0]!.summary).toBe("NRMS took over");
  });

  it("--remove deletes only what it created (recording each removal), and nothing else", async () => {
    const dry = await run({ remove: true, dryRun: true });
    expect(dry.remove).toEqual({ removed: ["2026HLTH0002-000002", "only-by-key", "rural-update"], keptEventOwned: ["health-story"] });

    const before = await tableCounts(tdb);
    const changesBefore = (await changeRows(tdb)).length;
    const report = await run({ remove: true });
    expect(report.remove).toEqual({ removed: ["2026HLTH0002-000002", "only-by-key", "rural-update"], keptEventOwned: ["health-story"] });
    expect(changed(before, await tableCounts(tdb))).toEqual(["changes", "posts", "public_import_posts"]);
    expect(await tableCounts(tdb)).toMatchObject({ outbox_events: 0, outbox_deliveries: 0, public_import_posts: 0 });
    expect((await changeRows(tdb)).slice(changesBefore)).toEqual(["post.unpublished 2026HLTH0002-000002", "post.unpublished only-by-key", "post.unpublished rural-update"]);
    const left = (await tdb.db.execute<{ key: string }>(sql`select key from posts`)).rows.map((r) => r.key).sort();
    expect(left).toEqual(["2026HLTH0001-000001", "MINING-FACTSHEET", "health-story"]);

    await expect(run({ remove: true, dryRun: true }, null)).rejects.toThrow(/needs the database/);
    // A second --remove has nothing left to do.
    expect((await run({ remove: true })).remove).toEqual({ removed: [], keptEventOwned: [] });
  });
});
