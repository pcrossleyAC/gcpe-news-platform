import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { ReleaseRecord } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { createApp } from "../app";
import { applyRelease } from "../projections";
import { listenForUpdates, type UpdateTarget } from "../updates/notify";
import { createNewsTestDb, EVENT_SECRETS, TZ } from "../../test/helpers";
import { parseFilesImportArgs, type FilesImportCliOptions } from "./files-options";
import { createFilesApiClient, createLimiter, FILES_IMPORT_USER_AGENT, FilesRateLimitedError, RequestBudgetExhaustedError, runFilesImport } from "./files-run";

const FILES = "https://bcgovnews-etg7c8etapa6btfr.z03.azurefd.net";

// ---------------------------------------------------------------- the stub legacy API

type Answer = { status: number; body?: unknown };

interface Stub {
  base: string;
  /** Every request: path, User-Agent, start time. */
  log: { path: string; ua: string | undefined; at: number }[];
  /** Answers by post key (lower case); a key not here answers 404. */
  posts: Map<string, Answer>;
  /** The next N requests whose path includes `match` answer `status`. */
  failNext: { match: string; status: number; times: number }[];
  maxInFlight: number;
  delayMs: number;
  close: () => Promise<void>;
}

async function startStub(): Promise<Stub> {
  const stub = { log: [], posts: new Map(), failNext: [], maxInFlight: 0, delayMs: 0 } as unknown as Stub;
  let inFlight = 0;
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://stub");
    stub.log.push({ path: url.pathname + url.search, ua: req.headers["user-agent"], at: Date.now() });
    inFlight++;
    stub.maxInFlight = Math.max(stub.maxInFlight, inFlight);
    if (stub.delayMs) await new Promise((r) => setTimeout(r, stub.delayMs));
    inFlight--;
    const fail = stub.failNext.find((f) => f.times > 0 && url.pathname.includes(f.match));
    if (fail) {
      fail.times--;
      res.writeHead(fail.status).end();
      return;
    }
    const m = /^\/api\/Posts\/([^/]+)$/.exec(url.pathname);
    const answer = m ? stub.posts.get(decodeURIComponent(m[1]!).toLowerCase()) : undefined;
    if (!answer) return void res.writeHead(404).end();
    res.writeHead(answer.status, { "content-type": "application/json" }).end(answer.body === undefined ? "" : JSON.stringify(answer.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  stub.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () => new Promise((r) => server.close(() => r()));
  return stub;
}

/** The public PostDto's file fields for `key` (the rest of the DTO is irrelevant here). */
function dto(key: string, files: { translations?: string[] | null; assets?: string[] | null } = {}) {
  const items = (names: string[] | null | undefined) => (names == null ? null : names.map((n, i) => ({ key: `releases/${key.toLowerCase()}/${n}`, label: n, length: 100 + i })));
  return {
    key, kind: "releases", summary: "x",
    hasTranslations: files.translations != null, hasMediaAssets: files.assets != null,
    azureTranslations: items(files.translations), azureAssets: items(files.assets),
  };
}

const options = (over: Partial<FilesImportCliOptions> = {}): FilesImportCliOptions => ({
  from: "", filesBase: FILES, concurrency: 1, since: null, keys: [], refresh: false, all: false, dryRun: false, maxRequests: 0, ...over,
});
const fastClient = (base: string, over: { concurrency?: number; maxRequests?: number; intervalMs?: number } = {}) =>
  createFilesApiClient({ base, concurrency: over.concurrency ?? 1, maxRequests: over.maxRequests ?? 0, intervalMs: over.intervalMs ?? 0 });

// ---------------------------------------------------------------- options

describe("parseFilesImportArgs", () => {
  it("has the documented defaults", () => {
    expect(parseFilesImportArgs([])).toEqual({ from: "https://api.news.gov.bc.ca", filesBase: FILES, concurrency: 1, since: null, keys: [], refresh: false, all: false, dryRun: false, maxRequests: 0 });
  });
  it("parses every option, in both --flag value and --flag=value forms", () => {
    expect(parseFilesImportArgs(["--from", "http://x/", "--files-base=https://f.example/", "--concurrency", "4", "--since", "2026-10-01", "--keys", "a, b", "--keys=c", "--max-requests", "50", "--refresh", "--all", "--dry-run"])).toEqual({
      from: "http://x", filesBase: "https://f.example", concurrency: 4, since: "2026-10-01", keys: ["a", "b", "c"], refresh: true, all: true, dryRun: true, maxRequests: 50,
    });
  });
  it("rejects unknown arguments and bad values", () => {
    expect(() => parseFilesImportArgs(["--concurency", "2"])).toThrow(/Unknown argument/);
    expect(() => parseFilesImportArgs(["--concurrency", "5"])).toThrow(/1 to 4/);
    expect(() => parseFilesImportArgs(["--concurrency", "0"])).toThrow(/1 to 4/);
    expect(() => parseFilesImportArgs(["--since", "2026-02-30"])).toThrow(/YYYY-MM-DD/);
    expect(() => parseFilesImportArgs(["--since", "yesterday"])).toThrow(/YYYY-MM-DD/);
    expect(() => parseFilesImportArgs(["--files-base", "http://f.example"])).toThrow(/https/);
    expect(() => parseFilesImportArgs(["--keys"])).toThrow(/needs a value/);
  });
});

// ---------------------------------------------------------------- politeness

describe("createLimiter", () => {
  it("one worker: one start a second", () => {
    const l = createLimiter({ intervalMs: 1000, concurrency: 1, now: () => 0 });
    expect([l.reserve(0), l.reserve(0), l.reserve(0)]).toEqual([0, 1000, 2000]);
  });
  it("four workers: each at least 1 s apart, and all together at most four a second", () => {
    let clock = 0;
    const l = createLimiter({ intervalMs: 1000, concurrency: 4, now: () => clock });
    const starts: { w: number; at: number }[] = [];
    for (let round = 0; round < 5; round++) for (let w = 0; w < 4; w++) starts.push({ w, at: l.reserve(w) });
    clock = 100; // a late caller never gets a slot in the past
    starts.push({ w: 0, at: l.reserve(0) });
    for (let w = 0; w < 4; w++) {
      const mine = starts.filter((s) => s.w === w).map((s) => s.at);
      for (let i = 1; i < mine.length; i++) expect(mine[i]! - mine[i - 1]!).toBeGreaterThanOrEqual(1000);
    }
    const all = starts.map((s) => s.at).sort((a, b) => a - b);
    for (let i = 1; i < all.length; i++) expect(all[i]! - all[i - 1]!).toBeGreaterThanOrEqual(250);
    for (const t of all) expect(all.filter((u) => u >= t && u < t + 1000).length).toBeLessThanOrEqual(4);
  });
});

describe("createFilesApiClient", () => {
  let stub: Stub;
  beforeAll(async () => {
    stub = await startStub();
    stub.posts.set("k1", { status: 200, body: dto("K1", { translations: ["a.pdf"] }) });
    stub.posts.set("empty", { status: 200 });
  });
  afterAll(async () => {
    await stub.close();
  });

  it("sends the cutover User-Agent; a 404 or an empty answer is not-found", async () => {
    const client = fastClient(stub.base);
    expect((await client.getPost("K1", 0)).status).toBe("found");
    expect(await client.getPost("missing", 0)).toEqual({ status: "not-found", httpStatus: 404 });
    expect(await client.getPost("empty", 0)).toEqual({ status: "not-found", httpStatus: 200 });
    expect(stub.log.every((l) => l.ua === FILES_IMPORT_USER_AGENT)).toBe(true);
    expect(stub.log[0]!.path).toBe("/api/Posts/K1?api-version=1.0");
  });

  it("retries a 5xx exactly once", async () => {
    const client = fastClient(stub.base);
    stub.failNext.push({ match: "K1", status: 503, times: 1 });
    expect((await client.getPost("K1", 0)).status).toBe("found");
    stub.failNext.push({ match: "K1", status: 502, times: 5 });
    expect(await client.getPost("K1", 0)).toEqual({ status: "failed", httpStatus: 502 });
    expect(client.requests).toBe(4);
    stub.failNext.length = 0;
  });

  it("a 429 stops the client: no retry and no further request", async () => {
    const client = fastClient(stub.base);
    stub.failNext.push({ match: "K1", status: 429, times: 1 });
    const before = stub.log.length;
    await expect(client.getPost("K1", 0)).rejects.toBeInstanceOf(FilesRateLimitedError);
    await expect(client.getPost("K1", 0)).rejects.toBeInstanceOf(FilesRateLimitedError);
    expect(stub.log.length - before).toBe(1);
    expect(client.requests).toBe(1);
  });

  it("a 200 that isn't JSON is a failure, not a crash", async () => {
    const raw = createServer((_q, res) => res.writeHead(200, { "content-type": "text/html" }).end("<html>maintenance</html>"));
    await new Promise<void>((r) => raw.listen(0, "127.0.0.1", r));
    try {
      const client = fastClient(`http://127.0.0.1:${(raw.address() as AddressInfo).port}`);
      expect(await client.getPost("K1", 0)).toEqual({ status: "failed", httpStatus: 200 });
    } finally {
      await new Promise<void>((r) => raw.close(() => r()));
    }
  });

  it("--max-requests caps what it sends", async () => {
    const client = fastClient(stub.base, { maxRequests: 2 });
    await client.getPost("K1", 0);
    await client.getPost("K1", 0);
    await expect(client.getPost("K1", 0)).rejects.toBeInstanceOf(RequestBudgetExhaustedError);
    expect(client.requests).toBe(2);
  });

  // Windows CI saw starts 84-86 ms apart for a 100 ms gap: a timer fires up to the clock's
  // granularity (about 15 ms there) early. A fake clock whose sleep wakes 15 ms early: no request
  // may start before its slot.
  it("a timer that fires early never starts a request before its slot", async () => {
    let clock = 0;
    const starts: number[] = [];
    const client = createFilesApiClient({
      base: "http://files.example",
      concurrency: 1,
      intervalMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += Math.max(1, ms - 15);
      },
      fetchImpl: (async () => {
        starts.push(clock);
        return new Response(null, { status: 404 });
      }) as typeof fetch,
    });
    for (let i = 0; i < 3; i++) expect(await client.getPost("K1", 0)).toEqual({ status: "not-found", httpStatus: 404 });
    expect(starts).toEqual([0, 100, 200]);
  });

  it("concurrency: never more requests in flight than workers, and starts spaced interval/concurrency apart", async () => {
    stub.log.length = 0;
    stub.maxInFlight = 0;
    stub.delayMs = 120;
    try {
      const client = createFilesApiClient({ base: stub.base, concurrency: 2, intervalMs: 200 });
      const t0 = Date.now();
      await Promise.all([0, 1].map(async (w) => { for (let i = 0; i < 3; i++) await client.getPost("K1", w); }));
      const elapsed = Date.now() - t0;
      expect(stub.maxInFlight).toBeLessThanOrEqual(2);
      const starts = stub.log.map((l) => l.at).sort((a, b) => a - b);
      expect(starts).toHaveLength(6);
      // 6 starts at least 100 ms apart (each worker: at least 200 ms apart): ≥ 500 ms in all. Starts are
      // timed where the stub receives them, so a loaded runner adds delivery jitter; unpaced starts would be ~0 ms apart.
      for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(75);
      expect(elapsed).toBeGreaterThanOrEqual(500);
    } finally {
      stub.delayMs = 0;
    }
  });
});

// ---------------------------------------------------------------- the run against a News API database

/** Rows in every table of the public schema: the no-side-effects check compares these. */
async function tableCounts(tdb: TestDatabase): Promise<Record<string, number>> {
  const { rows } = await tdb.db.execute<{ t: string }>(sql`select tablename as t from pg_tables where schemaname = 'public' order by 1`);
  const out: Record<string, number> = {};
  for (const { t } of rows) out[t] = (await tdb.db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from "${t}"`))).rows[0]!.n;
  return out;
}
const changed = (a: Record<string, number>, b: Record<string, number>) => Object.keys(b).filter((t) => a[t] !== b[t]).sort();
const changeRows = async (tdb: TestDatabase) => (await tdb.db.execute<{ kind: string; key: string }>(sql`select kind, key from changes order by id`)).rows.map((r) => `${r.kind} ${r.key}`);
const fileCols = async (tdb: TestDatabase, key: string) =>
  (await tdb.db.execute<{ translations: unknown; assets: unknown; has_translations: boolean; has_media_assets: boolean }>(sql`select translations, assets, has_translations, has_media_assets from posts where key = ${key}`)).rows[0];

describe("runFilesImport", () => {
  let tdb: TestDatabase;
  let stub: Stub;
  const notifications: { target: UpdateTarget; keys: string[] }[] = [];
  let stopListening: () => Promise<void>;

  const legacy = (key: string, day: number, flags: { t?: boolean; a?: boolean } = {}): ReleaseRecord => ({
    ...sampleRelease, key, publishDate: `2026-10-${String(day).padStart(2, "0")}T10:00:00-07:00`, hasTranslations: !!flags.t, hasMediaAssets: !!flags.a,
  });

  beforeAll(async () => {
    tdb = await createNewsTestDb();
    stub = await startStub();
    const write = (r: ReleaseRecord, origin: "legacy" | "event" = "legacy") => tdb.db.transaction((tx) => applyRelease(tx, r, { notify: false, origin }));
    await write(legacy("2026AA0001-000001", 1, { t: true })); // translations
    await write(legacy("2026AA0002-000002", 2, { a: true })); // media assets
    await write(legacy("2026AA0003-000003", 3)); // no flags: only with --all
    await write(legacy("2026AA0004-000004", 4, { t: true })); // gone from the source: 404
    await write(legacy("2026AA0005-000005", 5, { t: true }), "event"); // NRMS-published: never
    await write(legacy("2026AA0006-000006", 6, { t: true })); // unpublished below: never
    await tdb.db.execute(sql`update posts set is_published = false where key = '2026AA0006-000006'`);
    stub.posts.set("2026aa0001-000001", { status: 200, body: dto("2026AA0001-000001", { translations: ["Flyer_Chinese(simplified).pdf", "Flyer_Punjabi.pdf"] }) });
    stub.posts.set("2026aa0002-000002", { status: 200, body: dto("2026AA0002-000002", { assets: ["b-roll one.mp4"] }) });
    stub.posts.set("2026aa0003-000003", { status: 200, body: dto("2026AA0003-000003") });
    for (const k of ["2026aa0005-000005", "2026aa0006-000006"]) stub.posts.set(k, { status: 200, body: dto(k.toUpperCase(), { translations: ["x.pdf"] }) });
    const listener = await listenForUpdates(tdb.pool, (target, keys) => notifications.push({ target, keys }));
    stopListening = listener.stop;
  });
  afterAll(async () => {
    await stopListening();
    await stub.close();
    await tdb.drop();
  });

  const run = (over: Partial<FilesImportCliOptions> = {}, client = fastClient(stub.base)) => runFilesImport({ db: tdb.db, client }, options(over), { staleFlagsThreshold: 1 });

  it("a dry run lists the flagged legacy posts, newest first, sends nothing and writes nothing", async () => {
    const before = await tableCounts(tdb);
    stub.log.length = 0;
    const report = await run({ dryRun: true, concurrency: 4 });
    expect(report).toMatchObject({ mode: "dry-run", candidates: 3, sample: ["2026AA0004-000004", "2026AA0002-000002", "2026AA0001-000001"], requests: 0 });
    expect(report.estimate).toEqual({ requests: 3, hours: 0, concurrency: 4 });
    expect(stub.log).toEqual([]);
    expect(changed(before, await tableCounts(tdb))).toEqual([]);
  });

  it("fills translations and assets with absolute URLs; only posts and the change feed change; no event, no NOTIFY", async () => {
    const before = await tableCounts(tdb);
    const changesBefore = (await changeRows(tdb)).length;
    notifications.length = 0;
    stub.log.length = 0;
    const report = await run();
    expect(report).toMatchObject({ mode: "import", candidates: 3, requests: 3, filled: 2, unchanged: 0, notFound: ["2026AA0004-000004"], failed: [], invalid: [], skippedEventOwned: [], remaining: 0, stopped: null, resume: null, reachedPublishDate: "2026-10-01" });
    expect(stub.log.map((l) => l.path)).toEqual(["2026AA0004-000004", "2026AA0002-000002", "2026AA0001-000001"].map((k) => `/api/Posts/${k}?api-version=1.0`));

    expect(changed(before, await tableCounts(tdb))).toEqual(["changes"]); // posts: updated in place
    expect(await tableCounts(tdb)).toMatchObject({ outbox_events: 0, outbox_deliveries: 0, inbox_events: 0 });
    await new Promise((r) => setTimeout(r, 200));
    expect(notifications).toEqual([]);
    expect((await changeRows(tdb)).slice(changesBefore)).toEqual(["post.upserted 2026AA0002-000002", "post.upserted 2026AA0001-000001"]);

    expect(await fileCols(tdb, "2026AA0001-000001")).toEqual({
      translations: [
        { key: `${FILES}/translations/releases/2026aa0001-000001/Flyer_Chinese%28simplified%29.pdf`, label: "Flyer_Chinese(simplified).pdf", length: 100 },
        { key: `${FILES}/translations/releases/2026aa0001-000001/Flyer_Punjabi.pdf`, label: "Flyer_Punjabi.pdf", length: 101 },
      ],
      assets: null, has_translations: true, has_media_assets: false,
    });
    expect(await fileCols(tdb, "2026AA0002-000002")).toMatchObject({ translations: null, assets: [{ key: `${FILES}/assets/releases/2026aa0002-000002/b-roll%20one.mp4`, label: "b-roll one.mp4", length: 100 }], has_media_assets: true });
    // Untouched: no flags, NRMS-owned, unpublished.
    for (const k of ["2026AA0003-000003", "2026AA0005-000005", "2026AA0006-000006"]) expect((await fileCols(tdb, k))!.translations).toBeNull();
  });

  it("the News API then serves the files as news.gov's public API would, with absolute URLs", async () => {
    const app = createApp({ db: tdb.db, timeZone: TZ, eventSecrets: EVENT_SECRETS });
    const body = (await request(app).get("/api/Posts/2026AA0002-000002?api-version=1.0")).body;
    expect(body).toMatchObject({ hasMediaAssets: true, hasTranslations: false, azureTranslations: null, azureAssets: [{ key: `${FILES}/assets/releases/2026aa0002-000002/b-roll%20one.mp4`, label: "b-roll one.mp4", length: 100 }] });
  });

  it("a re-run skips filled posts (only the 404 is asked again) and writes nothing", async () => {
    const before = await tableCounts(tdb);
    stub.log.length = 0;
    const report = await run();
    expect(report).toMatchObject({ candidates: 1, filled: 0, notFound: ["2026AA0004-000004"] });
    expect(stub.log.map((l) => l.path)).toEqual(["/api/Posts/2026AA0004-000004?api-version=1.0"]);
    expect(changed(before, await tableCounts(tdb))).toEqual([]);
  });

  it("--refresh asks for filled posts again: an unchanged answer writes nothing, a changed one is written", async () => {
    const before = await tableCounts(tdb);
    expect(await run({ refresh: true })).toMatchObject({ candidates: 3, filled: 0, unchanged: 2 });
    expect(changed(before, await tableCounts(tdb))).toEqual([]);
    stub.posts.set("2026aa0001-000001", { status: 200, body: dto("2026AA0001-000001", { translations: ["Flyer_French.pdf"] }) });
    const changesBefore = (await changeRows(tdb)).length;
    expect(await run({ refresh: true })).toMatchObject({ filled: 1, unchanged: 1 });
    expect((await changeRows(tdb)).slice(changesBefore)).toEqual(["post.upserted 2026AA0001-000001"]);
    expect(((await fileCols(tdb, "2026AA0001-000001"))!.translations as { label: string }[]).map((t) => t.label)).toEqual(["Flyer_French.pdf"]);
  });

  it("--since, --keys and --all choose the posts", async () => {
    expect((await run({ dryRun: true, refresh: true, since: "2026-10-02" })).sample).toEqual(["2026AA0004-000004", "2026AA0002-000002"]);
    expect((await run({ dryRun: true, all: true })).sample).toEqual(["2026AA0004-000004", "2026AA0003-000003"]);
    // --keys: exactly those (flag or not), still never an NRMS-owned or unpublished one.
    expect((await run({ dryRun: true, keys: ["2026aa0003-000003", "2026AA0005-000005", "2026AA0006-000006"] })).sample).toEqual(["2026AA0003-000003"]);
    // A post the source lists no files for is recorded as checked (two empty lists), so a plain
    // re-run doesn't ask again; --refresh does.
    expect(await run({ keys: ["2026AA0003-000003"] })).toMatchObject({ withoutFiles: 1, filled: 1 });
    expect(await fileCols(tdb, "2026AA0003-000003")).toMatchObject({ translations: [], assets: [] });
    expect(await run({ keys: ["2026AA0003-000003"] })).toMatchObject({ candidates: 0 });
    expect(await run({ keys: ["2026AA0003-000003"], refresh: true })).toMatchObject({ candidates: 1, withoutFiles: 1, unchanged: 1 });
  });

  it("a 429 stops the run with what was done kept and how to resume", async () => {
    await tdb.db.execute(sql`update posts set translations = null, assets = null where key in ('2026AA0001-000001', '2026AA0002-000002')`);
    stub.failNext.push({ match: "2026AA0002", status: 429, times: 1 });
    stub.log.length = 0;
    const report = await run();
    expect(report).toMatchObject({ candidates: 3, requests: 2, filled: 0, notFound: ["2026AA0004-000004"], remaining: 2, stopped: "rate-limited", reachedPublishDate: "2026-10-04" });
    expect(report.resume).toMatch(/429.*run the same command again.*--since/s);
    expect(stub.log).toHaveLength(2); // the 429 is not retried, and nothing follows it
    // Re-running carries on.
    expect(await run()).toMatchObject({ filled: 2, stopped: null, remaining: 0 });
  });

  it("--max-requests stops after that many, with a resume hint", async () => {
    await tdb.db.execute(sql`update posts set translations = null, assets = null where key in ('2026AA0001-000001', '2026AA0002-000002')`);
    const report = await run({ maxRequests: 2 }, fastClient(stub.base, { maxRequests: 2 }));
    expect(report).toMatchObject({ requests: 2, filled: 1, remaining: 1, stopped: "max-requests" });
    expect(report.resume).toMatch(/--max-requests 2 reached/);
  });

  it("concurrency 2 handles every post once", async () => {
    await tdb.db.execute(sql`update posts set translations = null, assets = null where key in ('2026AA0001-000001', '2026AA0002-000002')`);
    stub.log.length = 0;
    const report = await run({ concurrency: 2 }, fastClient(stub.base, { concurrency: 2 }));
    expect(report).toMatchObject({ candidates: 3, filled: 2, notFound: ["2026AA0004-000004"], remaining: 0 });
    expect(stub.log.map((l) => l.path).sort()).toEqual(["2026AA0001-000001", "2026AA0002-000002", "2026AA0004-000004"].map((k) => `/api/Posts/${k}?api-version=1.0`));
  });

  it("an NRMS publish between the fetch and the write wins: the post is left alone", async () => {
    await tdb.db.execute(sql`update posts set translations = null where key = '2026AA0001-000001'`);
    const client = fastClient(stub.base);
    const racing = {
      get requests() {
        return client.requests;
      },
      async getPost(key: string, w: number) {
        const res = await client.getPost(key, w);
        await tdb.db.transaction((tx) => applyRelease(tx, legacy("2026AA0001-000001", 1, { t: true })));
        return res;
      },
    };
    const report = await run({ keys: ["2026AA0001-000001"] }, racing as never);
    expect(report.skippedEventOwned).toEqual(["2026AA0001-000001"]);
    expect((await fileCols(tdb, "2026AA0001-000001"))!.translations).toBeNull();
  });

  it("refuses a flagged-only run on a database imported before HasTranslations was carried", async () => {
    await tdb.db.execute(sql`update posts set has_translations = false`);
    await expect(runFilesImport({ db: tdb.db, client: fastClient(stub.base) }, options({ dryRun: true }), { staleFlagsThreshold: 1 })).rejects.toThrow(/Re-run import:legacy first.*--all/);
    await expect(runFilesImport({ db: tdb.db, client: fastClient(stub.base) }, options({ dryRun: true, all: true }), { staleFlagsThreshold: 1 })).resolves.toMatchObject({ mode: "dry-run" });
  });
});
