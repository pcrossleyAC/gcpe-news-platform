import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createGuardedEmbedder, standInProvider } from "@gcpe/embeddings";
import type { ReleaseRecord } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { jsonErrorHandler } from "@gcpe/http-kit";
import { createNewsTestDb, TZ } from "../../test/helpers";
import { runEmbeddingTick } from "../embeddings/worker";
import { v2Routes } from "../http/v2/routes";
import { applyRelease, unpublishRelease } from "../projections";
import { createRelatedService, type RelatedService } from "./related";

function release(key: string, headline: string, o: { lead?: string | null; tags?: string[]; publishDate?: string } = {}): ReleaseRecord {
  const lead = o.lead === undefined ? "health" : o.lead;
  return {
    ...sampleRelease,
    key,
    reference: null,
    summary: null,
    keywords: null,
    location: null,
    publishDate: o.publishDate ?? "2026-10-01T10:00:00-07:00",
    leadMinistryKey: lead,
    ministryKeys: lead ? [lead] : [],
    sectorKeys: [],
    tagKeys: o.tags ?? ["fish"],
    documents: [{ ...sampleRelease.documents[0]!, headline, subheadline: "", detailsHtml: "" }],
  };
}

describe("related posts (spec §5.4)", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE posts CASCADE");
  });
  const seed = async (...rs: ReleaseRecord[]) => {
    for (const r of rs) await tdb.db.transaction((tx) => applyRelease(tx, r, { notify: false }));
  };
  const embedAll = async () => {
    const embedder = createGuardedEmbedder({ provider: standInProvider(), log: () => {} });
    while ((await runEmbeddingTick({ db: tdb.db, embedder })).embedded > 0);
  };
  const svc = (semantic = true) =>
    createRelatedService({ db: tdb.db, timeZone: TZ, defaultLanguageId: 4105, publicSiteUrl: "https://site.example.test", semantic });
  const keys = (r: Awaited<ReturnType<RelatedService["related"]>>) => r?.results.map((x) => x.key);

  it("lists the stored nearest neighbours in semantic mode, nearest first, in the search result shape", async () => {
    await seed(release("P0", "salmon river habitat"), release("P1", "salmon river habitat work"), release("P2", "salmon river"), release("P3", "salmon"));
    await embedAll();
    const res = await svc().related("p0");
    expect(res?.mode).toBe("semantic");
    expect(keys(res)).toEqual(["P1", "P2", "P3"]);
    expect(res?.results[0]).toEqual({
      key: "P1",
      kind: "releases",
      headline: "salmon river habitat work",
      summary: null,
      publishDate: "2026-10-01T10:00:00-07:00",
      leadMinistryKey: "health",
      hasTranslations: false,
      hasMediaAssets: false,
      hasTranslationList: false,
      hasMediaAssetList: false,
      url: "https://site.example.test/releases/P1",
    });
  });

  it("drops related keys that are no longer published, and falls back when none is left", async () => {
    await seed(release("P0", "salmon river habitat"), release("P1", "salmon river habitat work"), release("P2", "salmon river"));
    await embedAll();
    // Published after P0's list was computed, so only the text fallback can find it.
    await seed(release("P3", "budget notes", { publishDate: "2026-10-05T10:00:00-07:00" }));
    await tdb.db.transaction((tx) => unpublishRelease(tx, "P1"));
    expect(keys(await svc().related("P0"))).toEqual(["P2"]);
    await tdb.db.transaction((tx) => unpublishRelease(tx, "P2"));
    expect(await svc().related("P0")).toMatchObject({ mode: "text", results: [{ key: "P3" }] });
  });

  it("without a stored list, falls back to the newest published posts sharing the lead ministry and a tag", async () => {
    await seed(
      release("X", "anchor", { lead: "Health", tags: ["Fish"] }),
      release("A", "a", { lead: "HEALTH", tags: ["fish"], publishDate: "2026-10-03T10:00:00-07:00" }),
      release("D", "d", { tags: ["fish", "rivers"], publishDate: "2026-10-02T10:00:00-07:00" }),
      release("NO-TAG", "b", { tags: ["other"] }),
      release("OTHER-MIN", "c", { lead: "finance", tags: ["fish"] }),
      release("GONE", "e", { tags: ["fish"], publishDate: "2026-10-04T10:00:00-07:00" }),
    );
    await tdb.db.transaction((tx) => unpublishRelease(tx, "GONE"));
    const res = await svc().related("x");
    expect(res?.mode).toBe("text");
    expect(keys(res)).toEqual(["A", "D"]);
  });

  it("uses the fallback while semantic mode is off, even with a stored list", async () => {
    await seed(release("P0", "salmon river habitat"), release("P1", "salmon river habitat work"));
    await embedAll();
    expect(await svc(false).related("P0")).toMatchObject({ mode: "text", results: [{ key: "P1" }] });
  });

  it("answers an empty list for a post with no lead ministry or no tags", async () => {
    await seed(release("NOLEAD", "a", { lead: null }), release("NOTAGS", "b", { tags: [] }), release("PEER", "c"));
    expect(await svc(false).related("NOLEAD")).toEqual({ mode: "text", results: [] });
    expect(await svc(false).related("NOTAGS")).toEqual({ mode: "text", results: [] });
  });

  it("is null for an unknown or an unpublished key", async () => {
    await seed(release("GONE", "a"));
    await tdb.db.transaction((tx) => unpublishRelease(tx, "GONE"));
    expect(await svc().related("nope")).toBeNull();
    expect(await svc().related("GONE")).toBeNull();
  });
});

describe("GET /api/v2/posts/{key}/related (HTTP)", () => {
  const calls: string[] = [];
  const stub: RelatedService = {
    async related(key) {
      calls.push(key);
      return key === "known" ? { mode: "text", results: [] } : null;
    },
  };
  const app = () => {
    const a = express();
    a.use("/api/v2", v2Routes({ related: stub }));
    a.use(jsonErrorHandler({ logPrefix: "[news-api]" }));
    return a;
  };
  afterEach(() => {
    calls.length = 0;
    vi.restoreAllMocks();
  });

  it("answers 200 with the service's response and no-store", async () => {
    const res = await request(app()).get("/api/v2/posts/known/related");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: "text", results: [] });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("passes a 200-character key through", async () => {
    await request(app()).get(`/api/v2/posts/${"k".repeat(200)}/related`);
    expect(calls).toEqual(["k".repeat(200)]);
  });

  it.each([
    ["an unknown key", "/api/v2/posts/unknown/related", 404, ["unknown"]],
    ["a NUL", "/api/v2/posts/a%00b/related", 404, []],
    ["201 characters", `/api/v2/posts/${"k".repeat(201)}/related`, 404, []],
    ["malformed percent-encoding", "/api/v2/posts/%E0%A4%A/related", 400, []],
  ])("%s: %s -> %i, no-store, nothing logged, never a 500", async (_label, path, status, called) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app()).get(path);
    expect(res.status).toBe(status);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(calls).toEqual(called);
    expect(error).not.toHaveBeenCalled();
  });
});
