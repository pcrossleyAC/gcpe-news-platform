import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createGuardedEmbedder, EmbeddingError, standInProvider, type EmbeddingProvider } from "@gcpe/embeddings";
import type { ReleaseRecord } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { closeHandle, createNewsTestDb, EVENT_SECRETS, TZ, writeTenantConfig } from "../../test/helpers";
import { runEmbeddingTick } from "../embeddings/worker";
import { applyRelease, unpublishRelease } from "../projections";
import { startNewsApi } from "../start";
import type { SearchQuery } from "./query";
import { createSemanticSearch, pageWindow } from "./semantic";
import { createSearchService } from "./service";
import { QueryVectorCache } from "./vector-cache";

describe("pageWindow", () => {
  it.each([
    [1, 0, { vectorStart: 0, vectorEnd: 0, textOffset: 0, textLimit: 20 }],
    [1, 5, { vectorStart: 0, vectorEnd: 5, textOffset: 0, textLimit: 15 }],
    [1, 25, { vectorStart: 0, vectorEnd: 20, textOffset: 0, textLimit: 0 }],
    [2, 25, { vectorStart: 20, vectorEnd: 25, textOffset: 0, textLimit: 15 }],
    [3, 25, { vectorStart: 25, vectorEnd: 25, textOffset: 15, textLimit: 20 }],
    [2, 20, { vectorStart: 20, vectorEnd: 20, textOffset: 0, textLimit: 20 }],
    [50, 1000, { vectorStart: 980, vectorEnd: 1000, textOffset: 0, textLimit: 0 }],
  ])("page %i with %i vector keys", (page, count, expected) => {
    expect(pageWindow(page, count)).toEqual(expected);
  });
});

const FILLER = Array.from({ length: 60 }, (_, i) => `filler${i}`).join(" ");

function release(key: string, headline: string, o: { body?: string; publishDate?: string; ministryKeys?: string[] } = {}): ReleaseRecord {
  return {
    ...sampleRelease,
    key,
    reference: null,
    summary: null,
    keywords: null,
    location: null,
    publishDate: o.publishDate ?? "2026-10-01T10:00:00-07:00",
    leadMinistryKey: o.ministryKeys?.[0] ?? null,
    ministryKeys: o.ministryKeys ?? [],
    sectorKeys: [],
    documents: [{ ...sampleRelease.documents[0]!, headline, subheadline: "", detailsHtml: o.body ? `<p>${o.body}</p>` : "" }],
  };
}

describe("semantic mode (spec §5.4)", () => {
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
  afterEach(() => vi.restoreAllMocks());

  const seed = async (...rs: ReleaseRecord[]) => {
    for (const r of rs) await tdb.db.transaction((tx) => applyRelease(tx, r, { notify: false }));
    const embedder = createGuardedEmbedder({ provider: standInProvider(), log: () => {} });
    while ((await runEmbeddingTick({ db: tdb.db, embedder })).embedded > 0);
  };
  function service(provider: EmbeddingProvider = standInProvider(), logs: { guarded: string[]; service: string[] } = { guarded: [], service: [] }) {
    const embedder = createGuardedEmbedder({ provider, log: (l) => logs.guarded.push(l) });
    const semantic = createSemanticSearch({ db: tdb.db, embedder, cache: new QueryVectorCache(), language: "english", defaultLanguageId: 4105, threshold: 0.5 });
    return createSearchService({ db: tdb.db, timeZone: TZ, language: "english", defaultLanguageId: 4105, publicSiteUrl: "https://site.example.test", semantic, log: (l) => logs.service.push(l) });
  }
  const q = (over: Partial<SearchQuery> = {}): SearchQuery => ({ q: "salmon habitat restoration", page: 1, ...over });
  const counting = () => {
    const base = standInProvider();
    const calls: string[][] = [];
    const provider: EmbeddingProvider = { ...base, async embed(texts, signal) { calls.push(texts); return base.embed(texts, signal); } };
    return { provider, calls };
  };

  it("puts vector matches first, nearest first, then text matches not already listed", async () => {
    await seed(
      release("V-EXACT", "salmon habitat restoration"),
      release("V-NEAR", "salmon habitat"),
      // Has all three words, so it is a text match, but among 60 other words it is far in vector terms.
      release("T-ONLY", "Budget notes", { body: `salmon habitat restoration ${FILLER}` }),
      release("NONE", "School bus routes"),
    );
    const res = await service().search(q());
    expect(res.mode).toBe("semantic");
    expect(res.total).toBe(3);
    expect(res.results.map((r) => r.key)).toEqual(["V-EXACT", "V-NEAR", "T-ONLY"]);
    expect(res.results[0]!.url).toBe("https://site.example.test/releases/V-EXACT");
  });

  it("pages across the vector and text groups without repeating a post", async () => {
    const vectors = Array.from({ length: 22 }, (_, i) => release(`V-${String(i).padStart(2, "0")}`, `salmon habitat restoration n${i}`));
    const texts = [1, 2, 3].map((d) => release(`T-${d}`, "Budget notes", { body: `salmon habitat restoration ${FILLER}`, publishDate: `2026-10-0${d}T10:00:00-07:00` }));
    await seed(...vectors, ...texts);
    const svc = service();
    const p1 = await svc.search(q({ page: 1 }));
    const p2 = await svc.search(q({ page: 2 }));
    expect(p1.total).toBe(25);
    expect(p2.total).toBe(25);
    const k1 = p1.results.map((r) => r.key);
    const k2 = p2.results.map((r) => r.key);
    expect(k1).toHaveLength(20);
    expect(k1.every((k) => k.startsWith("V-"))).toBe(true);
    expect(k2.slice(0, 2).every((k) => k.startsWith("V-"))).toBe(true);
    expect(k2.slice(2)).toEqual(["T-3", "T-2", "T-1"]);
    expect(new Set([...k1, ...k2]).size).toBe(25);
  });

  it("applies the filters to the vector branch too", async () => {
    await seed(release("V-HEALTH", "salmon habitat restoration", { ministryKeys: ["health"] }), release("V-OTHER", "salmon habitat restoration", { ministryKeys: ["finance"] }));
    const res = await service().search(q({ ministry: "Health" }));
    expect(res.results.map((r) => r.key)).toEqual(["V-HEALTH"]);
  });

  it("never returns an unpublished post", async () => {
    await seed(release("V-GONE", "salmon habitat restoration"), release("V-STAY", "salmon habitat"));
    await tdb.db.transaction((tx) => unpublishRelease(tx, "V-GONE"));
    expect((await service().search(q())).results.map((r) => r.key)).toEqual(["V-STAY"]);
  });

  it("embeds each normalised query once within five minutes", async () => {
    await seed(release("V-EXACT", "salmon habitat restoration"));
    const { provider, calls } = counting();
    const svc = service(provider);
    await svc.search(q({ q: "Salmon habitat restoration!" }));
    await svc.search(q({ q: "  salmon   HABITAT restoration " }));
    expect(calls).toEqual([["salmon habitat restoration"]]);
  });

  it("answers text mode without calling the provider when the query normalises to nothing", async () => {
    const { provider, calls } = counting();
    const res = await service(provider).search(q({ q: "!!!" }));
    expect(res.mode).toBe("text");
    expect(calls).toEqual([]);
  });

  it("falls back to text mode when the provider fails, with one log line, from the guarded embedder", async () => {
    await seed(release("T-ONLY", "Budget notes", { body: "salmon habitat restoration" }));
    const failing: EmbeddingProvider = { id: "failing", model: "m", dimensions: 1536, embed: async () => { throw new EmbeddingError("embedding_http_503"); } };
    const logs = { guarded: [] as string[], service: [] as string[] };
    const res = await service(failing, logs).search(q());
    expect(res).toMatchObject({ mode: "text", total: 1 });
    expect(logs.guarded).toEqual(["[embeddings] failing call failed embedding_http_503"]);
    expect(logs.service).toEqual([]);
  });

  it("logs nothing, and calls nothing, while the breaker is open", async () => {
    let calls = 0;
    const failing: EmbeddingProvider = { id: "failing", model: "m", dimensions: 1536, embed: async () => { calls++; throw new EmbeddingError("embedding_http_503"); } };
    const logs = { guarded: [] as string[], service: [] as string[] };
    const svc = service(failing, logs);
    for (let i = 0; i < 3; i++) await svc.search(q({ q: `query ${i}` }));
    for (let i = 0; i < 5; i++) expect((await svc.search(q({ q: `open ${i}` }))).mode).toBe("text");
    expect(calls).toBe(3);
    expect(logs.guarded).toHaveLength(3);
    expect(logs.service).toEqual([]);
  });

  it("startNewsApi serves semantic mode once posts are embedded, and text mode with the flag off", async () => {
    for (const [flag, mode] of [[true, "semantic"], [false, "text"]] as const) {
      const own = await createNewsTestDb();
      const handle = await startNewsApi(
        { DATABASE_URL: own.url, EVENT_SECRETS: JSON.stringify(EVENT_SECRETS), TENANT_CONFIG: writeTenantConfig({ features: { semanticSearch: flag, staffAi: false } }), EMBEDDINGS_PROVIDER: "stand-in" },
        { hub: false },
      );
      try {
        await own.db.transaction((tx) => applyRelease(tx, release("V-EXACT", "salmon habitat restoration"), { notify: false }));
        await handle.workers.embed!();
        const res = await request(handle.app).get("/api/v2/search?q=salmon%20habitat%20restoration");
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ mode, total: 1, results: [{ key: "V-EXACT" }] });
      } finally {
        await closeHandle(handle);
        await own.drop();
      }
    }
  });
});
