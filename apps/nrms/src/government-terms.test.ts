import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { GovernmentTermsPayload, SubscriberConfig } from "@gcpe/events";
import { createNrmsTestDb, requireBcTzdata2026b } from "../test/helpers";
import { startSiteLoop } from "./website/carousel";
import type { SlideImageFiles } from "./website/slide-images";
import { fileURLToPath } from "node:url";
import { loadTenantConfig } from "@gcpe/config";
import { addDays, publicTerms, seedGovernmentTerms, syncGovernmentTerms, termSpans } from "./government-terms";
import { governmentTerms } from "./db/schema";

type Row = typeof governmentTerms.$inferSelect;

let n = 0;
function row(name: string, startDate: string | null, extra: Partial<Row> = {}): Row {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name,
    isCurrent: false,
    legacyId: null,
    startDate,
    label: null,
    legacyArchiveUrl: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...extra,
  };
}

describe("termSpans", () => {
  it("computes non-overlapping ranges", () => {
    const spans = termSpans([row("2024-2028", "2024-11-18"), row("2020-2024", "2020-11-26")], "2026-10-28");
    expect(spans.map((s) => ({ startDate: s.startDate, endDate: s.endDate, status: s.status }))).toEqual([
      { startDate: "2020-11-26", endDate: "2024-11-17", status: "past" },
      { startDate: "2024-11-18", endDate: null, status: "current" },
    ]);
    expect(spans[0]!.slug).toBe("2020-2024");
  });

  it("a future term is scheduled and closes the current one in the Hub view only", () => {
    const spans = termSpans([row("2020-2024", "2020-11-26"), row("2024-2028", "2024-11-18"), row("2028-11-20", "2028-11-20")], "2026-10-28");
    expect(spans.map((s) => s.status)).toEqual(["past", "current", "scheduled"]);
    expect(spans[1]!.endDate).toBe("2028-11-19");
    expect(spans[2]!.endDate).toBeNull();
    const pub = publicTerms(spans);
    expect(pub).toHaveLength(2);
    expect(pub[0]).toMatchObject({ slug: "2024-2028", endDate: null });
    expect(pub[1]).toMatchObject({ slug: "2020-2024", endDate: "2024-11-17" });
  });

  it("undated rows are listed last and never current", () => {
    const spans = termSpans([row("tbd", null), row("2024-2028", "2024-11-18"), row("2020-2024", "2020-11-26")], "2026-10-28");
    expect(spans.map((s) => s.slug)).toEqual(["2020-2024", "2024-2028", "tbd"]);
    expect(spans[2]).toMatchObject({ status: "undated", startDate: null, endDate: null });
    expect(publicTerms(spans).map((t) => t.slug)).toEqual(["2024-2028", "2020-2024"]);
  });

  it("the day of the start date is current", () => {
    const rows = [row("2024-2028", "2024-11-18"), row("2028-11-20", "2028-11-20")];
    expect(termSpans(rows, "2028-11-19")[1]!.status).toBe("scheduled");
    const spans = termSpans(rows, "2028-11-20");
    expect(spans.map((s) => s.status)).toEqual(["past", "current"]);
    expect(spans[0]!.endDate).toBe("2028-11-19");
  });

  it("everything is scheduled before the first term starts; none is current", () => {
    const spans = termSpans([row("a", "2030-01-01")], "2026-10-28");
    expect(spans.map((s) => s.status)).toEqual(["scheduled"]);
    expect(publicTerms(spans)).toEqual([]);
  });

  it("carries label, archive url and legacy id through", () => {
    const [s] = termSpans([row("2024-2028", "2024-11-18", { label: "Eby government", legacyArchiveUrl: "https://x/y.htm", legacyId: "abc" })], "2026-10-28");
    expect(s).toMatchObject({ label: "Eby government", legacyArchiveUrl: "https://x/y.htm", legacyId: "abc" });
  });
});

describe("addDays", () => {
  it("does UTC date arithmetic across month, year and leap boundaries", () => {
    expect(addDays("2024-11-18", -1)).toBe("2024-11-17");
    expect(addDays("2025-01-01", -1)).toBe("2024-12-31");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2023-02-28", 1)).toBe("2023-03-01");
    expect(addDays("2026-03-08", 0)).toBe("2026-03-08");
  });
});

describe("syncGovernmentTerms", () => {
  const TZ = "America/Vancouver";
  const subs: SubscriberConfig[] = [{ name: "news-api", url: "http://news.invalid/events", secret: "s".repeat(40), types: ["*"] }];
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE government_terms, government_terms_published, outbox_events, outbox_deliveries, aggregate_sequences CASCADE");
    await tdb.db.insert(governmentTerms).values([
      { name: "2024-2028", startDate: "2024-11-18" },
      { name: "2028-11-20", startDate: "2028-11-20" },
    ]);
  });

  const at = (iso: string) => () => new Date(iso);
  const sync = (iso: string) => tdb.db.transaction((tx) => syncGovernmentTerms(tx, { timeZone: TZ, subscribers: subs, now: at(iso) }));
  const published = async () =>
    (await tdb.pool.query("SELECT aggregate_id, envelope->'data' AS data FROM outbox_events WHERE type = 'government_terms.published' ORDER BY sequence")).rows as {
      aggregate_id: string;
      data: GovernmentTermsPayload;
    }[];
  const currentNames = async () => (await tdb.pool.query("SELECT name FROM government_terms WHERE is_current ORDER BY name")).rows.map((r: { name: string }) => r.name);

  it("tick emits once when a scheduled term starts", async () => {
    await requireBcTzdata2026b(tdb.pool);
    // BC is on permanent UTC-7 from 2026-11-01 (tzdata 2026b), so 06:59Z is 23:59 BC on the eve
    // of the swearing-in. The first call is the first publish; the second is a no-op.
    expect(await sync("2028-11-20T06:59:00Z")).toEqual({ emitted: true });
    expect(await sync("2028-11-20T06:59:00Z")).toEqual({ emitted: false });
    expect((await published()).map((e) => e.data.currentSlug)).toEqual(["2024-2028"]);
    expect(await currentNames()).toEqual(["2024-2028"]);

    // 00:00 BC on the swearing-in day: the term rolls over by itself.
    expect(await sync("2028-11-20T07:00:00Z")).toEqual({ emitted: true });
    const events = await published();
    expect(events).toHaveLength(2);
    expect(events[1]!.aggregate_id).toBe("government-terms");
    expect(events[1]!.data.currentSlug).toBe("2028-11-20");
    expect(events[1]!.data.publishedAt).toBe("2028-11-20T07:00:00.000Z");
    expect(events[1]!.data.terms).toEqual([
      { slug: "2028-11-20", label: null, startDate: "2028-11-20", endDate: null, legacyArchiveUrl: null },
      { slug: "2024-2028", label: null, startDate: "2024-11-18", endDate: "2028-11-19", legacyArchiveUrl: null },
    ]);
    expect(await currentNames()).toEqual(["2028-11-20"]);
    expect(await sync("2028-11-20T09:00:00Z")).toEqual({ emitted: false });
  });

  it("two concurrent rollovers (site loop and stack tick) publish exactly one snapshot", async () => {
    // Flag already right, so no row lock on government_terms serialises them: only the advisory lock does.
    await tdb.pool.query("UPDATE government_terms SET is_current = true WHERE name = '2024-2028'");
    const results = await Promise.all([sync("2026-12-15T20:00:00Z"), sync("2026-12-15T20:00:00Z")]);
    expect(results.map((r) => r.emitted).sort()).toEqual([false, true]);
    expect(await published()).toHaveLength(1);
    expect(await currentNames()).toEqual(["2024-2028"]);
  });

  it("scheduled terms are not in the payload", async () => {
    await sync("2026-10-28T12:00:00Z");
    const [e] = await published();
    expect(e!.data.currentSlug).toBe("2024-2028");
    expect(e!.data.terms.map((t) => t.slug)).toEqual(["2024-2028"]);
    expect(e!.data.terms[0]!.endDate).toBeNull();
  });

  it("corrects a wrong is_current flag left by the old importer", async () => {
    await tdb.pool.query("UPDATE government_terms SET is_current = true WHERE name = '2028-11-20'");
    await sync("2026-10-28T12:00:00Z");
    expect(await currentNames()).toEqual(["2024-2028"]);
    // Corrected even when the payload is unchanged (hash already stored).
    await tdb.pool.query("UPDATE government_terms SET is_current = false");
    await tdb.pool.query("UPDATE government_terms SET is_current = true WHERE name = '2028-11-20'");
    expect(await sync("2026-10-28T12:00:00Z")).toEqual({ emitted: false });
    expect(await currentNames()).toEqual(["2024-2028"]);
  });

  it("clears is_current when no dated term has started", async () => {
    await tdb.pool.query("TRUNCATE government_terms CASCADE");
    await tdb.db.insert(governmentTerms).values([{ name: "undated", isCurrent: true }, { name: "2030-01-01", startDate: "2030-01-01" }]);
    expect(await sync("2026-10-28T12:00:00Z")).toEqual({ emitted: true });
    expect(await currentNames()).toEqual([]);
    expect((await published())[0]!.data).toMatchObject({ currentSlug: null, terms: [] });
  });

  it("the site loop runs the rollover on each tick, without a test clock", async () => {
    const files = { store: {}, filesBase: "" } as unknown as SlideImageFiles;
    const stop = startSiteLoop({ db: tdb.db, subscribers: subs, files, timeZone: TZ, intervalMs: 5 });
    const start = Date.now();
    while ((await published()).length === 0 && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 10));
    await stop();
    const events = await published();
    expect(events).toHaveLength(1);
    // Real clock: which term is current depends on today, but the flag and the event agree.
    expect(await currentNames()).toEqual([events[0]!.data.currentSlug]);
  });

  it("a label edit changes the hash and republishes", async () => {
    await sync("2026-10-28T12:00:00Z");
    await tdb.pool.query("UPDATE government_terms SET label = 'Eby government' WHERE name = '2024-2028'");
    expect(await sync("2026-10-28T12:01:00Z")).toEqual({ emitted: true });
    expect((await published())[1]!.data.terms[0]!.label).toBe("Eby government");
  });
});

describe("seedGovernmentTerms (NG-R17)", () => {
  const TZ = "America/Vancouver";
  const subs: SubscriberConfig[] = [{ name: "news-api", url: "http://news.invalid/events", secret: "s".repeat(40), types: ["*"] }];
  const seed = loadTenantConfig(fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url))).governmentTerms!;
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE government_terms, government_terms_published, outbox_events, outbox_deliveries, aggregate_sequences CASCADE");
  });
  const run = (terms = seed) =>
    tdb.db.transaction((tx) => seedGovernmentTerms(tx, terms, { timeZone: TZ, subscribers: subs, now: () => new Date("2026-10-28T19:00:00Z") }));
  const events = async () =>
    (await tdb.pool.query("SELECT envelope->'data' AS data FROM outbox_events WHERE type = 'government_terms.published' ORDER BY sequence")).rows as { data: GovernmentTermsPayload }[];
  const rows = async () =>
    (await tdb.pool.query("SELECT name, start_date::text AS start_date, legacy_archive_url, label, is_current, legacy_id FROM government_terms ORDER BY start_date")).rows;

  it("an empty table gets BC's 9 terms, the current one flagged, and one snapshot", async () => {
    expect(await run()).toEqual({ seeded: 9, emitted: true });
    const r = await rows();
    expect(r.map((x) => [x.name, x.start_date])).toEqual(seed.map((t) => [t.slug, t.startDate]));
    expect(r.find((x) => x.name === "2024-2028")).toMatchObject({ is_current: true, legacy_archive_url: "https://archive.news.gov.bc.ca/releases/index_current.htm", label: null, legacy_id: null });
    expect(r.filter((x) => x.is_current)).toHaveLength(1);
    const [e, ...more] = await events();
    expect(more).toEqual([]);
    expect(e!.data.currentSlug).toBe("2024-2028");
    expect(e!.data.terms.map((t) => t.slug)).toEqual([...seed].reverse().map((t) => t.slug));
    expect(e!.data.terms.at(-1)).toEqual({ slug: "pre2001", label: null, startDate: "1994-01-01", endDate: "2001-06-04", legacyArchiveUrl: "https://archive.news.gov.bc.ca/releases/index_pre2001.htm" });
  });

  it("a table with any row is left untouched, and nothing is published", async () => {
    await tdb.db.insert(governmentTerms).values({ name: "2024-2028", startDate: "2024-11-20", legacyArchiveUrl: "https://elsewhere.example/x" });
    expect(await run()).toEqual({ seeded: 0, emitted: false });
    expect(await rows()).toEqual([{ name: "2024-2028", start_date: "2024-11-20", legacy_archive_url: "https://elsewhere.example/x", label: null, is_current: false, legacy_id: null }]);
    expect(await events()).toEqual([]);
  });

  it("re-running is a no-op", async () => {
    await run();
    const before = await rows();
    expect(await run()).toEqual({ seeded: 0, emitted: false });
    expect(await rows()).toEqual(before);
    expect(await events()).toHaveLength(1);
  });

  it("a tenant with no terms seeds nothing", async () => {
    expect(await run([])).toEqual({ seeded: 0, emitted: false });
    expect(await rows()).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it("two concurrent starts seed once", async () => {
    const results = await Promise.all([run(), run()]);
    expect(results.map((r) => r.seeded).sort()).toEqual([0, 9]);
    expect(await rows()).toHaveLength(9);
    expect(await events()).toHaveLength(1);
  });
});
