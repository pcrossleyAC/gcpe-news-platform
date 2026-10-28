import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { sampleRelease } from "@gcpe/events/testing";
import { jsonErrorHandler } from "@gcpe/http-kit";
import { createApp } from "../../app";
import { createNewsTestDb, envelope, EVENT_SECRETS, sendEvent, TZ } from "../../../test/helpers";
import type { SearchQuery } from "../../search/query";
import { createSearchService, type SearchService } from "../../search/service";
import { v2Routes } from "./routes";

const MARKER = "zqxmarker";

function stubApp(search: SearchService | undefined) {
  const app = express();
  app.use("/api/v2", v2Routes({ search }));
  app.use(jsonErrorHandler({ logPrefix: "[news-api]" }));
  return app;
}

describe("GET /api/v2/search (HTTP)", () => {
  const calls: SearchQuery[] = [];
  const stub: SearchService = {
    timeZone: TZ,
    async search(query) {
      calls.push(query);
      return { mode: "text", page: query.page, total: 0, results: [] };
    },
  };
  afterEach(() => {
    calls.length = 0;
    vi.restoreAllMocks();
  });

  it("answers 200 with no-store and passes the parsed query through", async () => {
    const res = await request(stubApp(stub)).get("/api/v2/search?q=%20wildfire%20&ministry=Health&page=2");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ mode: "text", page: 2, total: 0, results: [] });
    expect(calls).toEqual([{ q: "wildfire", ministry: "Health", page: 2 }]);
  });

  it("with a filter and no q, passes an empty q through (filter-only search)", async () => {
    const res = await request(stubApp(stub)).get("/api/v2/search?ministry=citizens-services");
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ q: "", ministry: "citizens-services", page: 1 }]);
  });

  it("passes the request's own AbortSignal to the search service (the seam 6b's semantic branch uses)", async () => {
    let seen: unknown;
    const capturing: SearchService = {
      timeZone: TZ,
      async search(query, signal) {
        seen = signal;
        return { mode: "text", page: query.page, total: 0, results: [] };
      },
    };
    const res = await request(stubApp(capturing)).get("/api/v2/search?q=wildfire");
    expect(res.status).toBe(200);
    expect(seen).toBeInstanceOf(AbortSignal);
    expect((seen as AbortSignal).aborted).toBe(false);
  });

  it.each([
    ["", "q"],
    [`q=${MARKER}&q=${MARKER}`, "q"],
    [`q=${"a".repeat(201)}${MARKER}`, "q"],
    [`q=x&page=0`, "page"],
    [`q=x&page=51`, "page"],
    [`q=x&page=1.5`, "page"],
    [`q=x&type=${MARKER}`, "type"],
    [`q=x&from=2026-02-30`, "from"],
    [`q=x&from=0099-01-01`, "from"],
    [`q=x&from=2026-10-02&to=2026-10-01`, "to"],
    [`q=${MARKER}%00x`, "q"],
    [`q=%00`, "q"],
    [`q=x&ministry=${MARKER}%00`, "ministry"],
    [`q=x&sector=%00${MARKER}`, "sector"],
  ])("refuses ?%s with a 400 naming %s, never echoing the value", async (qs, parameter) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(stubApp(stub)).get(`/api/v2/search?${qs}`);
    expect(res.status).toBe(400);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ error: { code: "InvalidParameter", parameter, message: expect.any(String) } });
    expect(res.text).not.toContain(MARKER);
    expect(calls).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  it("on a failure answers a generic 500 and logs the route and a safe label, never the query", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing: SearchService = { timeZone: TZ, search: async (query) => { throw new Error(`bad tsquery near ${query.q}`); } };
    const res = await request(stubApp(failing)).get(`/api/v2/search?q=${MARKER}&ministry=${MARKER}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal error" });
    expect(error).toHaveBeenCalledTimes(1);
    const logged = error.mock.calls[0]!.map(String).join(" ");
    expect(logged).toContain("/api/v2/search");
    expect(logged).not.toContain(MARKER);
    expect(logged).not.toContain("?");
  });

  it("answers any other v2 path, and search when no service is wired, with a JSON 404 and no-store", async () => {
    for (const [app, path] of [[stubApp(stub), "/api/v2/nope"], [stubApp(undefined), "/api/v2/search?q=x"]] as const) {
      const res = await request(app).get(path);
      expect(res.status).toBe(404);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toEqual({ error: "not found" });
    }
  });

  it("limits each client IP per minute, answering 429 with no-store (Q74)", async () => {
    const app = express();
    app.use("/api/v2", v2Routes({ search: stub, searchRateLimit: { perMinute: 2, clientIpHeader: "x-client-ip" } }));
    const get = (ip: string) => request(app).get("/api/v2/search?q=x").set("x-client-ip", ip);
    expect((await get("203.0.113.1")).status).toBe(200);
    expect((await get("203.0.113.1")).status).toBe(200);
    const limited = await get("203.0.113.1");
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: "too many requests" });
    expect(limited.headers["cache-control"]).toBe("no-store");
    expect((await get("203.0.113.2")).status).toBe(200);
  });
});

describe("GET /api/v2/search through createApp (real Postgres)", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
    const search = createSearchService({ db: tdb.db, timeZone: TZ, language: "english", defaultLanguageId: 4105, publicSiteUrl: "https://news.example.test" });
    app = createApp({ db: tdb.db, timeZone: TZ, eventSecrets: EVENT_SECRETS, search });
    await sendEvent(app, envelope("nrms", "release.published", sampleRelease.key, sampleRelease));
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("finds a release published by event, without api-version", async () => {
    const res = await request(app).get("/api/v2/search?q=highway");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: "text",
      total: 1,
      results: [{ key: sampleRelease.key, publishDate: "2026-10-01T15:10:00-07:00", url: `https://news.example.test/releases/${sampleRelease.key}` }],
    });
  });

  it("leaves v1 as it was: api-version still required, and no search column in a post", async () => {
    expect((await request(app).get("/api/Home")).status).toBe(400);
    const post = await request(app).get(`/api/Posts/${sampleRelease.key}?api-version=1.0`);
    expect(post.status).toBe(200);
    expect(Object.keys(post.body)).not.toContain("searchText");
    expect(Object.keys(post.body)).not.toContain("searchVector");
    expect(post.headers["cache-control"]).toBe("no-cache");
  });
});

// The public site's "Search <ministry> news" link is /search/?ministry=<key> with no text.
// Legacy (NewsroomController.Search) sends Azure Search no `search` term then, so it lists the
// filter's posts, newest first ($orderby publishDateTime desc); q is optional once a filter is set.
describe("GET /api/v2/search with filters and no q (real Postgres)", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  // 23 citizens-services posts a day apart (CS-00 oldest … CS-22 newest), one stories-kind
  // among them, and one other ministry's post that must never appear.
  const day = (i: number) => `2026-09-${String(i + 1).padStart(2, "0")}T10:00:00-07:00`;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
    const search = createSearchService({ db: tdb.db, timeZone: TZ, language: "english", defaultLanguageId: 4105, publicSiteUrl: "https://news.example.test" });
    app = createApp({ db: tdb.db, timeZone: TZ, eventSecrets: EVENT_SECRETS, search });
    const records = [
      ...Array.from({ length: 23 }, (_, i) => ({
        ...sampleRelease,
        key: `CS-${String(i).padStart(2, "0")}`,
        kind: i === 5 ? ("stories" as const) : ("releases" as const),
        publishDate: day(i),
        leadMinistryKey: "citizens-services",
        ministryKeys: ["citizens-services"],
        sectorKeys: i % 2 === 0 ? ["economy"] : [],
      })),
      { ...sampleRelease, key: "OTHER-1", publishDate: day(29), leadMinistryKey: "finance", ministryKeys: ["finance"], sectorKeys: [] },
    ];
    for (const r of records) await sendEvent(app, envelope("nrms", "release.published", r.key, r));
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const csKeysNewestFirst = Array.from({ length: 23 }, (_, i) => `CS-${String(22 - i).padStart(2, "0")}`);

  it("a ministry filter alone lists that ministry's posts newest first, 20 a page, same total on each page", async () => {
    const p1 = await request(app).get("/api/v2/search?ministry=citizens-services");
    expect(p1.status).toBe(200);
    expect(p1.body).toMatchObject({ mode: "text", page: 1, total: 23 });
    expect(p1.body.results.map((r: { key: string }) => r.key)).toEqual(csKeysNewestFirst.slice(0, 20));
    expect(p1.body.results[0]).toEqual({
      key: "CS-22",
      kind: "releases",
      headline: expect.any(String),
      summary: sampleRelease.summary,
      publishDate: "2026-09-23T10:00:00-07:00",
      leadMinistryKey: "citizens-services",
      url: "https://news.example.test/releases/CS-22",
    });
    const p2 = await request(app).get("/api/v2/search?ministry=citizens-services&page=2");
    expect(p2.body).toMatchObject({ mode: "text", page: 2, total: 23 });
    expect(p2.body.results.map((r: { key: string }) => r.key)).toEqual(csKeysNewestFirst.slice(20));
  });

  it("an empty or blank q with a filter is the same filter-only search", async () => {
    for (const qs of ["q=&ministry=Citizens-Services", "q=%20%20&ministry=citizens-services"]) {
      const res = await request(app).get(`/api/v2/search?${qs}`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(23);
      expect(res.body.results[0].key).toBe("CS-22");
    }
  });

  it("every other filter counts too: sector, type, from/to", async () => {
    const sector = await request(app).get("/api/v2/search?sector=economy");
    expect(sector.body.total).toBe(12);
    expect(sector.body.results[0].key).toBe("CS-22");
    const type = await request(app).get("/api/v2/search?type=stories");
    expect(type.body.results.map((r: { key: string }) => r.key)).toEqual(["CS-05"]);
    const range = await request(app).get("/api/v2/search?from=2026-09-29&to=2026-09-30");
    expect(range.body.results.map((r: { key: string }) => r.key)).toEqual(["OTHER-1"]);
  });

  it("q is still required with no filter: 400 naming q", async () => {
    for (const qs of ["", "q=", "q=%20", "page=2"]) {
      const res = await request(app).get(`/api/v2/search?${qs}`);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { code: "InvalidParameter", parameter: "q", message: expect.any(String) } });
    }
  });

  it("text plus a filter still ranks by text and filters", async () => {
    const res = await request(app).get("/api/v2/search?q=highway&ministry=finance");
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { key: string }) => r.key)).toEqual(["OTHER-1"]);
  });
});
