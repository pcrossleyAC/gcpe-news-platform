import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { sampleRelease } from "@gcpe/events/testing";
import type { ReleaseRecord } from "@gcpe/events";
import { createNewsTestDb, TZ } from "../../test/helpers";
import { applyRelease } from "../projections";
import { ConcurrencyGate, defaultSemanticConcurrency } from "./concurrency-gate";
import type { SearchQuery } from "./query";
import { ResultCache } from "./result-cache";
import { createSearchService, type SemanticSearch } from "./service";
import type { SearchPage } from "./text-search";

const OPTS = { language: "english" as const, defaultLanguageId: 4105 };

function release(key: string, body: string, over: Partial<ReleaseRecord> = {}): ReleaseRecord {
  return {
    ...sampleRelease,
    key,
    reference: null,
    kind: "releases",
    summary: null,
    keywords: null,
    location: null,
    publishDate: "2026-10-01T10:00:00-07:00",
    leadMinistryKey: null,
    ministryKeys: [],
    sectorKeys: [],
    documents: [{ ...sampleRelease.documents[0]!, headline: key, detailsHtml: `<p>${body}</p>` }],
    ...over,
  };
}

describe("ResultCache", () => {
  it("expires by TTL", () => {
    let now = 0;
    const c = new ResultCache<string>({ ttlMs: 1000, maxEntries: 10, maxBytes: 1000, now: () => now });
    c.set("a", "A", 1);
    now = 999;
    expect(c.get("a")).toBe("A");
    now = 1000;
    expect(c.get("a")).toBeUndefined();
    expect(c.size).toBe(0);
    expect(c.byteSize).toBe(0);
  });
  it("drops the least recently used past maxEntries", () => {
    const c = new ResultCache<string>({ ttlMs: 1000, maxEntries: 2, maxBytes: 1000 });
    c.set("a", "A", 1);
    c.set("b", "B", 1);
    c.get("a");
    c.set("c", "C", 1);
    expect([c.get("a"), c.get("b"), c.get("c")]).toEqual(["A", undefined, "C"]);
  });
  it("drops oldest past maxBytes and never stores a value over the budget", () => {
    const c = new ResultCache<string>({ ttlMs: 1000, maxEntries: 10, maxBytes: 10 });
    c.set("a", "A", 6);
    c.set("b", "B", 6);
    expect([c.get("a"), c.get("b"), c.byteSize]).toEqual([undefined, "B", 6]);
    c.set("big", "X", 11);
    expect([c.get("big"), c.get("b")]).toEqual([undefined, "B"]);
  });
});

describe("ConcurrencyGate", () => {
  const gate = (o: Partial<ConstructorParameters<typeof ConcurrencyGate>[0]> = {}) => new ConcurrencyGate({ maxActive: 1, maxQueue: 1, queueWaitMs: 50, ...o });
  it("refuses beyond the queue and hands a freed slot to the waiter", async () => {
    const g = gate();
    const first = await g.acquire();
    expect(first).toBeTypeOf("function");
    const waiting = g.acquire();
    expect(await g.acquire()).toBeNull(); // queue full
    first!();
    const second = await waiting;
    expect(second).toBeTypeOf("function");
    expect([g.running, g.queued]).toEqual([1, 0]);
    second!();
    second!(); // idempotent
    expect(g.running).toBe(0);
  });
  it("refuses a waiter after queueWaitMs and on abort", async () => {
    const g = gate();
    await g.acquire();
    expect(await g.acquire()).toBeNull();
    const ac = new AbortController();
    const p = g.acquire(ac.signal);
    ac.abort();
    expect(await p).toBeNull();
    expect(g.queued).toBe(0);
  });
  it("defaults to max(2, cores - 1)", () => {
    expect([defaultSemanticConcurrency(1), defaultSemanticConcurrency(2), defaultSemanticConcurrency(4), defaultSemanticConcurrency(16)]).toEqual([2, 2, 3, 15]);
  });
});

describe("search service: result cache and semantic cap", () => {
  let tdb: TestDatabase;
  const q = (over: Partial<SearchQuery> = {}): SearchQuery => ({ q: "wildfire", page: 1, pageSize: 20, ...over });
  const CACHE = { ttlMs: 60_000, maxEntries: 500, maxBytes: 1 << 20 };
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await tdb.pool.query("TRUNCATE posts CASCADE");
    await tdb.db.transaction((tx) => applyRelease(tx, release("R-1", "wildfire near Kamloops", { ministryKeys: ["health"] }), { notify: false }));
    await tdb.db.transaction((tx) => applyRelease(tx, release("R-2", "wildfire near Kelowna"), { notify: false }));
  });
  const svc = (o: Partial<Parameters<typeof createSearchService>[0]> = {}) =>
    createSearchService({ db: tdb.db, timeZone: TZ, ...OPTS, publicSiteUrl: "https://news.example.test", log: () => {}, ...o });

  it("without a cache option every call reaches the database", async () => {
    const spy = vi.spyOn(tdb.db, "transaction");
    const s = svc();
    await s.search(q());
    await s.search(q());
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("an identical query within the TTL hits the database once, whitespace-normalised", async () => {
    const spy = vi.spyOn(tdb.db, "transaction");
    const s = svc({ cache: CACHE });
    const a = await s.search(q());
    const b = await s.search(q({ q: "wildfire" }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
    expect(a.total).toBe(2);
  });

  it("different text, filters, page, page size and facets are separate entries", async () => {
    const spy = vi.spyOn(tdb.db, "transaction");
    const s = svc({ cache: CACHE });
    const variants = [q(), q({ q: "kelowna" }), q({ ministry: "health" }), q({ sector: "x" }), q({ type: "stories" }), q({ from: new Date("2026-09-01") }), q({ toExclusive: new Date("2026-11-01") }), q({ page: 2 }), q({ pageSize: 10 }), q({ facets: true })];
    for (const v of variants) await s.search(v);
    expect(spy).toHaveBeenCalledTimes(variants.length);
    for (const v of variants) await s.search(v);
    expect(spy).toHaveBeenCalledTimes(variants.length);
  });

  it("collapses internal whitespace but keeps case (OR is an operator)", async () => {
    const spy = vi.spyOn(tdb.db, "transaction");
    const s = svc({ cache: CACHE });
    await s.search(q({ q: "wildfire   near" }));
    await s.search(q({ q: "wildfire near" }));
    expect(spy).toHaveBeenCalledTimes(1);
    await s.search(q({ q: "wildfire OR near" }));
    await s.search(q({ q: "wildfire or near" }));
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("reaches the database again after the TTL", async () => {
    let now = 1_000;
    const spy = vi.spyOn(tdb.db, "transaction");
    const s = svc({ cache: { ...CACHE, now: () => now } });
    await s.search(q());
    now += 59_999;
    await s.search(q());
    expect(spy).toHaveBeenCalledTimes(1);
    now += 1;
    await s.search(q());
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("evicts the least recently used entry past maxEntries", async () => {
    const spy = vi.spyOn(tdb.db, "transaction");
    const s = svc({ cache: { ...CACHE, maxEntries: 2 } });
    await s.search(q({ q: "one" }));
    await s.search(q({ q: "two" }));
    await s.search(q({ q: "three" }));
    expect(spy).toHaveBeenCalledTimes(3);
    await s.search(q({ q: "three" }));
    expect(spy).toHaveBeenCalledTimes(3);
    await s.search(q({ q: "one" }));
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("never caches an error", async () => {
    const real = tdb.db.transaction.bind(tdb.db);
    const spy = vi.spyOn(tdb.db, "transaction").mockRejectedValueOnce(new Error("boom"));
    const s = svc({ cache: CACHE });
    await expect(s.search(q())).rejects.toThrow("boom");
    const ok = await s.search(q());
    expect(ok.total).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(real).toBeTypeOf("function");
  });

  it("identical queries in flight at once share one database read", async () => {
    const spy = vi.spyOn(tdb.db, "transaction");
    const s = svc({ cache: CACHE });
    const rs = await Promise.all([s.search(q()), s.search(q()), s.search(q())]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(rs[1]).toEqual(rs[0]);
  });

  it("a fallback answer (breaker open: semantic returned null) is not cached", async () => {
    const semantic: SemanticSearch = { search: vi.fn(async () => null) };
    const spy = vi.spyOn(tdb.db, "transaction");
    const s = svc({ cache: CACHE, semantic });
    await s.search(q());
    await s.search(q());
    expect(spy).toHaveBeenCalledTimes(2);
    expect(semantic.search).toHaveBeenCalledTimes(2);
  });

  it("a semantic answer is cached", async () => {
    const page: SearchPage = { total: 0, rows: [] };
    const semantic: SemanticSearch = { search: vi.fn(async () => page) };
    const s = svc({ cache: CACHE, semantic });
    expect((await s.search(q())).mode).toBe("semantic");
    await s.search(q());
    expect(semantic.search).toHaveBeenCalledTimes(1);
  });

  describe("semantic cap of 1", () => {
    const GATE = { maxActive: 1, maxQueue: 0, queueWaitMs: 0 };
    function slowSemantic() {
      let release!: () => void;
      const started = new Promise<void>((r) => (release = r));
      let finish!: () => void;
      const hold = new Promise<void>((r) => (finish = r));
      const semantic: SemanticSearch = {
        search: vi.fn(async () => {
          release();
          await hold;
          return { total: 0, rows: [] } satisfies SearchPage;
        }),
      };
      return { semantic, started, finish };
    }

    it("the second concurrent semantic query falls back to text, marked; the first completes", async () => {
      const { semantic, started, finish } = slowSemantic();
      const s = svc({ semantic, semanticGate: GATE });
      const first = s.search(q({ q: "wildfire" }));
      await started;
      const second = await s.search(q({ q: "kelowna" }));
      expect(second.mode).toBe("text");
      expect(second.fallback).toBe("capacity");
      expect(second.total).toBe(1);
      expect(semantic.search).toHaveBeenCalledTimes(1);
      finish();
      const done = await first;
      expect(done.mode).toBe("semantic");
      expect(done.fallback).toBeUndefined();
      // the slot is free again
      const third = await s.search(q({ q: "kamloops" }));
      expect(third.mode).toBe("semantic");
    });

    it("a filter-only search does not take a slot", async () => {
      const { semantic, started, finish } = slowSemantic();
      const s = svc({ semantic, semanticGate: GATE });
      const first = s.search(q());
      await started;
      const filterOnly = await s.search(q({ q: "", ministry: "health" }));
      expect(filterOnly.fallback).toBeUndefined();
      expect(filterOnly.total).toBe(1);
      finish();
      await first;
    });

    it("a capacity fallback is never cached", async () => {
      const { semantic, started, finish } = slowSemantic();
      const s = svc({ semantic, semanticGate: GATE, cache: CACHE });
      const first = s.search(q({ q: "wildfire" }));
      await started;
      expect((await s.search(q({ q: "kelowna" }))).fallback).toBe("capacity");
      finish();
      await first;
      expect((await s.search(q({ q: "kelowna" }))).mode).toBe("semantic");
    });

    it("a queued query that gets the slot in time is served semantically", async () => {
      const { semantic, started, finish } = slowSemantic();
      const s = svc({ semantic, semanticGate: { maxActive: 1, maxQueue: 1, queueWaitMs: 2000 } });
      const first = s.search(q({ q: "a" }));
      await started;
      const second = s.search(q({ q: "b" }));
      finish();
      expect((await first).mode).toBe("semantic");
      expect((await second).mode).toBe("semantic");
    });

    it("releases the slot when the semantic branch throws", async () => {
      const semantic: SemanticSearch = { search: vi.fn(async () => { throw new Error("sql"); }) };
      const s = svc({ semantic, semanticGate: GATE });
      await s.search(q());
      const r = await s.search(q({ q: "again" }));
      expect(r.fallback).toBeUndefined();
      expect(semantic.search).toHaveBeenCalledTimes(2);
    });
  });
});
