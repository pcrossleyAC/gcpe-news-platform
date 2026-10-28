import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { ReleaseRecord } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { createNewsTestDb, TZ } from "../../test/helpers";
import { applyGovernmentTerms, applyRelease, unpublishRelease } from "../projections";
import type { SearchQuery } from "./query";
import { createSearchService, type SemanticSearch } from "./service";
import { textSearch } from "./text-search";

const OPTS = { language: "english" as const, defaultLanguageId: 4105 };

function release(key: string, o: { headline?: string; body?: string; publishDate?: string; kind?: ReleaseRecord["kind"]; ministryKeys?: string[]; sectorKeys?: string[] } = {}): ReleaseRecord {
  return {
    ...sampleRelease,
    key,
    reference: null,
    kind: o.kind ?? "releases",
    summary: null,
    keywords: null,
    location: null,
    publishDate: o.publishDate ?? "2026-10-01T10:00:00-07:00",
    leadMinistryKey: o.ministryKeys?.[0] ?? null,
    ministryKeys: o.ministryKeys ?? [],
    sectorKeys: o.sectorKeys ?? [],
    documents: [{ ...sampleRelease.documents[0]!, headline: o.headline ?? key, detailsHtml: `<p>${o.body ?? ""}</p>` }],
  };
}

describe("textSearch and the search service", () => {
  let tdb: TestDatabase;
  const q = (over: Partial<SearchQuery>): SearchQuery => ({ q: "wildfire", page: 1, pageSize: 20, ...over });
  const keys = async (query: SearchQuery, excludeKeys?: string[]) => (await textSearch(tdb.db, query, { ...OPTS, excludeKeys })).rows.map((r) => r.key);
  const seed = async (...rs: ReleaseRecord[]) => {
    for (const r of rs) await tdb.db.transaction((tx) => applyRelease(tx, r, { notify: false }));
  };

  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE posts CASCADE");
  });

  it("ranks by ts_rank_cd, then newest first, then key", async () => {
    await seed(
      release("R-MANY", { headline: "Wildfire update", body: "wildfire crews and wildfire smoke", publishDate: "2026-10-01T10:00:00-07:00" }),
      release("R-ONE", { headline: "Budget", body: "one wildfire mention", publishDate: "2026-10-03T10:00:00-07:00" }),
      release("R-TIE-OLD", { headline: "Budget", body: "one wildfire mention", publishDate: "2026-10-02T10:00:00-07:00" }),
      release("R-NONE", { headline: "School", body: "nothing relevant" }),
    );
    expect(await keys(q({}))).toEqual(["R-MANY", "R-ONE", "R-TIE-OLD"]);
    expect((await textSearch(tdb.db, q({}), OPTS)).total).toBe(3);
  });

  it("matches word forms (english stemming) and websearch syntax", async () => {
    await seed(release("R-1", { body: "Wildfires near Kamloops" }), release("R-2", { body: "Wildfire near Kelowna" }));
    expect((await keys(q({ q: "wildfire" }))).sort()).toEqual(["R-1", "R-2"]);
    expect(await keys(q({ q: "wildfire -kelowna" }))).toEqual(["R-1"]);
    expect(await keys(q({ q: '"near kamloops"' }))).toEqual(["R-1"]);
  });

  it("filters by ministry and sector case-insensitively, and by type", async () => {
    await seed(
      release("R-HEALTH", { body: "wildfire", ministryKeys: ["Health"], sectorKeys: ["economy"] }),
      release("R-FIN", { body: "wildfire", ministryKeys: ["finance"] }),
      release("R-STORY", { body: "wildfire", kind: "stories" }),
    );
    expect(await keys(q({ ministry: "HEALTH" }))).toEqual(["R-HEALTH"]);
    expect(await keys(q({ sector: "Economy" }))).toEqual(["R-HEALTH"]);
    expect(await keys(q({ type: "stories" }))).toEqual(["R-STORY"]);
    expect(await keys(q({ ministry: "no-such-ministry" }))).toEqual([]);
  });

  it("from and to are whole BC calendar days", async () => {
    await seed(
      release("R-EARLY", { body: "wildfire", publishDate: "2026-10-01T00:30:00-07:00" }),
      release("R-LATE", { body: "wildfire", publishDate: "2026-10-01T23:59:00-07:00" }),
      release("R-NEXT", { body: "wildfire", publishDate: "2026-10-02T00:00:00-07:00" }),
    );
    const oct1 = { from: new Date("2026-10-01T07:00:00Z"), toExclusive: new Date("2026-10-02T07:00:00Z") };
    expect((await keys(q(oct1))).sort()).toEqual(["R-EARLY", "R-LATE"]);
    expect(await keys(q({ from: new Date("2026-10-02T07:00:00Z") }))).toEqual(["R-NEXT"]);
  });

  it("never returns an unpublished post", async () => {
    await seed(release("R-GONE", { body: "wildfire" }), release("R-LIVE", { body: "wildfire" }));
    await tdb.db.transaction((tx) => unpublishRelease(tx, "R-GONE"));
    expect(await keys(q({}))).toEqual(["R-LIVE"]);
  });

  it("pages 20 at a time with the same total on every page", async () => {
    await seed(...Array.from({ length: 25 }, (_, i) => release(`F-${String(i).padStart(2, "0")}`, { body: "ferry sailing" })));
    const p1 = await textSearch(tdb.db, q({ q: "ferry", page: 1 }), OPTS);
    const p2 = await textSearch(tdb.db, q({ q: "ferry", page: 2 }), OPTS);
    const p3 = await textSearch(tdb.db, q({ q: "ferry", page: 3 }), OPTS);
    expect([p1.rows.length, p2.rows.length, p3.rows.length]).toEqual([20, 5, 0]);
    expect([p1.total, p2.total, p3.total]).toEqual([25, 25, 25]);
    expect(new Set([...p1.rows, ...p2.rows].map((r) => r.key)).size).toBe(25);
  });

  it("a stop-word-only or punctuation-only query matches nothing and does not fail", async () => {
    await seed(release("R-1", { body: "the wildfire" }));
    for (const text of ["the", "!!!", "-", '"']) {
      expect(await textSearch(tdb.db, q({ q: text }), OPTS)).toEqual({ total: 0, rows: [] });
    }
  });

  it("drops excludeKeys, case-insensitively (the seam 6b's text branch uses)", async () => {
    await seed(release("R-A", { body: "wildfire" }), release("R-B", { body: "wildfire" }));
    expect(await keys(q({}), ["r-a"])).toEqual(["R-B"]);
  });

  it("takes the headline from the default-language document, else the first", async () => {
    const doc = sampleRelease.documents[0]!;
    await seed({
      ...release("R-BI", { body: "wildfire" }),
      documents: [
        { ...doc, languageId: 1036, headline: "Incendie", detailsHtml: "<p>wildfire</p>" },
        { ...doc, languageId: 4105, headline: "Wildfire", detailsHtml: "<p>wildfire</p>" },
      ],
    });
    expect((await textSearch(tdb.db, q({}), OPTS)).rows[0]?.headline).toBe("Wildfire");
  });

  describe("createSearchService", () => {
    const service = (semantic?: SemanticSearch | null, log?: (l: string) => void) =>
      createSearchService({ db: tdb.db, timeZone: TZ, ...OPTS, publicSiteUrl: "https://news.example.test/", semantic, log });

    it("answers text mode with the response shape, BC offsets and public URLs", async () => {
      await seed({ ...release("2026TT0103-001121", { headline: "Wildfire update", body: "wildfire" }), summary: "Crews respond.", leadMinistryKey: "forests", ministryKeys: ["forests"] });
      expect(await service().search(q({}))).toEqual({
        mode: "text",
        page: 1,
        pageSize: 20,
        total: 1,
        facets: null,
        results: [{
          key: "2026TT0103-001121",
          kind: "releases",
          headline: "Wildfire update",
          summary: "Crews respond.",
          publishDate: "2026-10-01T10:00:00-07:00",
          leadMinistryKey: "forests",
          hasTranslations: false,
          hasMediaAssets: false,
          hasTranslationList: false,
          hasMediaAssetList: false,
          url: "https://news.example.test/releases/2026TT0103-001121",
        }],
      });
    });

    it("results carry hasTranslations and hasMediaAssets", async () => {
      await seed(
        { ...release("R-BOTH", { body: "wildfire", publishDate: "2026-10-03T10:00:00-07:00" }), hasTranslations: true, hasMediaAssets: true },
        { ...release("R-TR", { body: "wildfire", publishDate: "2026-10-02T10:00:00-07:00" }), hasTranslations: true },
        release("R-NONE", { body: "wildfire", publishDate: "2026-10-01T10:00:00-07:00" }),
      );
      const res = await service().search(q({}));
      expect(res.results.map((r) => [r.key, r.hasTranslations, r.hasMediaAssets])).toEqual([
        ["R-BOTH", true, true],
        ["R-TR", true, false],
        ["R-NONE", false, false],
      ]);
    });

    it("hasTranslationList / hasMediaAssetList: the flag set AND a non-empty list (the raw flags stay legacy's)", async () => {
      const files = [{ key: "https://files.example/x.pdf", label: "x.pdf", length: 1 }];
      await seed(
        { ...release("L-FILLED", { body: "wildfire", publishDate: "2026-10-04T10:00:00-07:00" }), hasTranslations: true, hasMediaAssets: true, translations: files, assets: files },
        { ...release("L-EMPTY", { body: "wildfire", publishDate: "2026-10-03T10:00:00-07:00" }), hasTranslations: true, hasMediaAssets: true, translations: [], assets: [] },
        { ...release("L-NULL", { body: "wildfire", publishDate: "2026-10-02T10:00:00-07:00" }), hasTranslations: true, hasMediaAssets: true },
        { ...release("L-NOFLAG", { body: "wildfire", publishDate: "2026-10-01T10:00:00-07:00" }), translations: files, assets: files },
      );
      const res = await service().search(q({}));
      expect(res.results.map((r) => [r.key, r.hasTranslations, r.hasTranslationList, r.hasMediaAssets, r.hasMediaAssetList])).toEqual([
        ["L-FILLED", true, true, true, true],
        ["L-EMPTY", true, false, true, false],
        ["L-NULL", true, false, true, false],
        ["L-NOFLAG", false, false, false, false],
      ]);
    });

    it("pageSize 10 pages ten at a time with the same total", async () => {
      await seed(...Array.from({ length: 25 }, (_, i) => release(`P-${String(i).padStart(2, "0")}`, { body: "ferry sailing" })));
      const p1 = await service().search(q({ q: "ferry", pageSize: 10 }));
      const p3 = await service().search(q({ q: "ferry", pageSize: 10, page: 3 }));
      expect([p1.results.length, p3.results.length, p1.total, p3.total, p3.pageSize]).toEqual([10, 5, 25, 25, 10]);
    });

    describe("facets", () => {
      beforeEach(async () => {
        await tdb.pool.query("DELETE FROM government_terms");
      });
      const terms = (v: Parameters<typeof applyGovernmentTerms>[1]["terms"]) =>
        tdb.db.transaction((tx) => applyGovernmentTerms(tx, { publishedAt: "2026-10-20T00:00:00-07:00", currentSlug: "t2", terms: v }));
      const facets = async (over: Partial<SearchQuery> = {}, semantic?: SemanticSearch | null) => (await service(semantic).search(q({ facets: true, ...over }))).facets;

      it("counts ministries, sectors, types and terms over the filtered set, biggest first, zero counts left out", async () => {
        await terms([
          { slug: "t2", label: null, startDate: "2024-10-18", endDate: null, legacyArchiveUrl: null },
          { slug: "t1", label: null, startDate: "2017-07-18", endDate: "2024-10-17", legacyArchiveUrl: null },
          { slug: "t0", label: null, startDate: "2001-06-05", endDate: "2017-07-17", legacyArchiveUrl: null },
        ]);
        await seed(
          release("A", { body: "wildfire", ministryKeys: ["health", "finance"], sectorKeys: ["economy"], publishDate: "2025-03-01T10:00:00-08:00" }),
          release("B", { body: "wildfire", ministryKeys: ["health"], sectorKeys: ["economy", "mining"], kind: "stories", publishDate: "2024-10-17T23:59:00-07:00" }),
          release("C", { body: "wildfire", ministryKeys: ["finance", "finance"], kind: "stories", publishDate: "2024-10-18T00:00:00-07:00" }),
          release("D", { body: "wildfire", ministryKeys: ["education"], publishDate: "2020-01-01T10:00:00-08:00" }),
          release("NOMATCH", { body: "school", ministryKeys: ["health"] }),
        );
        expect(await facets()).toEqual({
          ministries: [{ key: "finance", count: 2 }, { key: "health", count: 2 }, { key: "education", count: 1 }],
          sectors: [{ key: "economy", count: 2 }, { key: "mining", count: 1 }],
          types: [{ key: "releases", count: 2 }, { key: "stories", count: 2 }],
          terms: [{ slug: "t1", count: 2 }, { slug: "t2", count: 2 }],
        });
      });

      it("uses exactly the results' filters, so a filter narrows every list", async () => {
        await seed(
          release("A", { body: "wildfire", ministryKeys: ["health"], sectorKeys: ["economy"] }),
          release("B", { body: "wildfire", ministryKeys: ["health"], kind: "stories" }),
          release("C", { body: "wildfire", ministryKeys: ["finance"], sectorKeys: ["mining"] }),
        );
        const f = await facets({ ministry: "Health" });
        expect(f).toEqual({
          ministries: [{ key: "health", count: 2 }],
          sectors: [{ key: "economy", count: 1 }],
          types: [{ key: "releases", count: 1 }, { key: "stories", count: 1 }],
          terms: [],
        });
        expect(f!.ministries.reduce((n, m) => n + m.count, 0)).toBe((await service().search(q({ ministry: "Health" }))).total);
      });

      it("never counts an unpublished post, and a no-match search has empty lists", async () => {
        await seed(release("GONE", { body: "wildfire", ministryKeys: ["health"] }));
        await tdb.db.transaction((tx) => unpublishRelease(tx, "GONE"));
        const empty = { ministries: [], sectors: [], types: [], terms: [] };
        expect(await facets()).toEqual(empty);
        expect(await facets({ q: "nothingmatches" })).toEqual(empty);
      });

      it("is null without facets=1 and in semantic mode", async () => {
        await seed(release("R-1", { body: "wildfire", ministryKeys: ["health"] }));
        expect((await service().search(q({}))).facets).toBeNull();
        const page = { total: 1, rows: [{ key: "R-1", kind: "releases", headline: "H", summary: null, publishDate: new Date("2026-10-01T17:00:00Z"), leadMinistryKey: null, hasTranslations: false, hasMediaAssets: false, hasTranslationList: false, hasMediaAssetList: false }] };
        const sem = await service({ search: async () => page }).search(q({ facets: true }));
        expect(sem).toMatchObject({ mode: "semantic", facets: null });
      });

      it("a filter-only search (empty q) has facets too", async () => {
        await seed(release("A", { ministryKeys: ["health"], sectorKeys: ["economy"] }), release("B", { ministryKeys: ["finance"] }));
        expect((await facets({ q: "", ministry: "health" }))?.sectors).toEqual([{ key: "economy", count: 1 }]);
      });
    });

    it("uses the semantic branch's page when it answers, and falls back to text on null or a throw", async () => {
      await seed(release("R-TEXT", { body: "wildfire" }));
      const page = { total: 1, rows: [{ key: "R-SEM", kind: "releases", headline: "H", summary: null, publishDate: new Date("2026-10-01T17:00:00Z"), leadMinistryKey: null, hasTranslations: false, hasMediaAssets: false, hasTranslationList: false, hasMediaAssetList: false }] };
      expect((await service({ search: async () => page }).search(q({})))).toMatchObject({ mode: "semantic", results: [{ key: "R-SEM" }] });
      expect((await service({ search: async () => null }).search(q({})))).toMatchObject({ mode: "text", results: [{ key: "R-TEXT" }] });
      const lines: string[] = [];
      const thrown = await service({ search: async () => { throw new Error("embedding wildfire failed"); } }, (l) => lines.push(l)).search(q({}));
      expect(thrown).toMatchObject({ mode: "text", results: [{ key: "R-TEXT" }] });
      expect(lines).toEqual(["[news-api] search semantic branch failed Error"]);
    });

    it("a filter-only search (empty q) never asks the semantic branch and lists newest first", async () => {
      await seed(
        release("R-OLD", { ministryKeys: ["health"], publishDate: "2026-10-01T10:00:00-07:00" }),
        release("R-NEW", { ministryKeys: ["health"], publishDate: "2026-10-03T10:00:00-07:00" }),
        release("R-OTHER", { ministryKeys: ["finance"], publishDate: "2026-10-04T10:00:00-07:00" }),
      );
      let asked = 0;
      const res = await service({ search: async () => { asked++; return null; } }).search(q({ q: "", ministry: "health" }));
      expect(asked).toBe(0);
      expect(res).toMatchObject({ mode: "text", page: 1, total: 2, results: [{ key: "R-NEW" }, { key: "R-OLD" }] });
    });

    it("passes the caller's AbortSignal through to the semantic branch (the seam 6b's guarded embedder uses)", async () => {
      const controller = new AbortController();
      let seen: AbortSignal | undefined;
      await service({
        search: async (_query, signal) => {
          seen = signal;
          return null;
        },
      }).search(q({}), controller.signal);
      expect(seen).toBe(controller.signal);
    });
  });
});
