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
