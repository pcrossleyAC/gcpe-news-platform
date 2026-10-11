import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { ReleaseRecord } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { createNewsTestDb, TZ } from "../../test/helpers";
import { applyRelease, unpublishRelease } from "../projections";
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
  const q = (over: Partial<SearchQuery>): SearchQuery => ({ q: "wildfire", page: 1, ...over });
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
        total: 1,
        results: [{
          key: "2026TT0103-001121",
          kind: "releases",
          headline: "Wildfire update",
          summary: "Crews respond.",
          publishDate: "2026-10-01T10:00:00-07:00",
          leadMinistryKey: "forests",
          url: "https://news.example.test/releases/2026TT0103-001121",
        }],
      });
    });

    it("uses the semantic branch's page when it answers, and falls back to text on null or a throw", async () => {
      await seed(release("R-TEXT", { body: "wildfire" }));
      const page = { total: 1, rows: [{ key: "R-SEM", kind: "releases", headline: "H", summary: null, publishDate: new Date("2026-10-01T17:00:00Z"), leadMinistryKey: null }] };
      expect((await service({ search: async () => page }).search(q({})))).toMatchObject({ mode: "semantic", results: [{ key: "R-SEM" }] });
      expect((await service({ search: async () => null }).search(q({})))).toMatchObject({ mode: "text", results: [{ key: "R-TEXT" }] });
      const lines: string[] = [];
      const thrown = await service({ search: async () => { throw new Error("embedding wildfire failed"); } }, (l) => lines.push(l)).search(q({}));
      expect(thrown).toMatchObject({ mode: "text", results: [{ key: "R-TEXT" }] });
      expect(lines).toEqual(["[news-api] search semantic branch failed Error"]);
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
