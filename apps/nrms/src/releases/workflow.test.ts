import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNrmsTestDb, editor, sampleCreate, seedTaxonomy } from "../../test/helpers";
import { governmentTerms } from "../db/schema";
import { ReleaseRuleError, ReleaseStateError } from "./errors";
import { bcYear, nextCounter } from "./numbering";
import { createRelease, saveCategories } from "./service";
import { loadView } from "./store";
import { approve, cancel, schedule, unpublish } from "./workflow";

const TZ = "America/Vancouver";
const deps = { timeZone: TZ };

describe("workflow", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
    await tdb.db.insert(governmentTerms).values({ name: "2024-2028", isCurrent: true });
  });
  afterAll(async () => {
    await tdb.drop();
  });
  const db = () => tdb.db;
  const year = bcYear(new Date(), TZ);

  it("bcYear uses BC local time at the new-year boundary", () => {
    expect(bcYear(new Date("2027-01-01T06:30:00Z"), TZ)).toBe(2026);
    expect(bcYear(new Date("2027-01-01T08:30:00Z"), TZ)).toBe(2027);
  });

  it("approve assigns the legacy key and a NEWS- reference, once", async () => {
    const v = await createRelease(db(), sampleCreate, editor);
    const a = await approve(db(), v.id, v.version, editor, deps);
    expect(a.status).toBe("approved");
    expect(a.reference).toMatch(/^NEWS-\d{5}$/);
    expect(a.key).toMatch(new RegExp(`^${year}HLTH\\d{4}-\\d{6}$`));
    await expect(approve(db(), v.id, a.version, editor, deps)).rejects.toEqual(new ReleaseStateError("This has already been approved."));
    const term = await tdb.db.execute<{ term_id: string | null }>(sql`SELECT term_id FROM news_releases WHERE id = ${v.id}`);
    expect(term.rows[0]!.term_id).not.toBeNull();
  });

  it("stories keep their slug key; advisories without a ministry use ADVIS", async () => {
    const s = await createRelease(db(), { ...sampleCreate, type: "story", headline: "Story time" }, editor);
    expect((await approve(db(), s.id, s.version, editor, deps)).key).toBe("story-time");
    const adv = await createRelease(db(), { ...sampleCreate, type: "advisory", ministries: [], leadMinistryKey: null, sectors: [], mediaListKeys: ["regional"] }, editor);
    expect((await approve(db(), adv.id, adv.version, editor, deps)).key).toMatch(new RegExp(`^${year}ADVIS\\d{4}-\\d{6}$`));
  });

  it("approve needs a lead ministry for non-advisories", async () => {
    const v = await createRelease(db(), { ...sampleCreate, ministries: ["health", "finance"], leadMinistryKey: null }, editor);
    await expect(approve(db(), v.id, v.version, editor, deps)).rejects.toEqual(new ReleaseRuleError(["Choose the lead ministry."]));
  });

  it("20 concurrent approvals get 20 distinct numbers", async () => {
    const created = await Promise.all(Array.from({ length: 20 }, () => createRelease(db(), sampleCreate, editor)));
    const approved = await Promise.all(created.map((v) => approve(db(), v.id, v.version, editor, deps)));
    expect(new Set(approved.map((a) => a.reference)).size).toBe(20);
    expect(new Set(approved.map((a) => a.key)).size).toBe(20);
  });

  it("nextCounter counts per scope", async () => {
    expect(await nextCounter(tdb.db, "year", 1999, "")).toBe(1);
    expect(await nextCounter(tdb.db, "year", 1999, "")).toBe(2);
    expect(await nextCounter(tdb.db, "ministry", 1999, "health")).toBe(1);
  });

  it("schedule: now rounds to the minute; >5 min in the past is refused; future logs the BC time", async () => {
    const v = await createRelease(db(), sampleCreate, editor);
    let a = await approve(db(), v.id, v.version, editor, deps);
    await expect(schedule(db(), v.id, { version: a.version, publishAt: new Date(Date.now() - 10 * 60_000).toISOString() }, editor, deps)).rejects.toEqual(new ReleaseRuleError(["The publish time is more than 5 minutes in the past."]));
    const s = await schedule(db(), v.id, { version: a.version, publishAt: "now" }, editor, deps);
    expect(s.status).toBe("scheduled");
    expect(new Date(s.publishAt!).getUTCSeconds()).toBe(0);
    const c = await cancel(db(), v.id, s.version, editor);
    expect(c.status).toBe("approved");
    const future = await schedule(db(), v.id, { version: c.version, publishAt: "2030-01-15T17:30:00Z" }, editor, deps);
    expect(future.publishAt).toBe("2030-01-15T17:30:00.000Z");
    const log = await tdb.db.execute<{ text: string }>(sql`SELECT text FROM release_log WHERE release_id = ${v.id} ORDER BY id`);
    expect(log.rows.map((r) => r.text)).toEqual(expect.arrayContaining(["Scheduled for Immediate Release", "Cancelled Release", "Scheduled for Release on January 15, 2030 at 10:30 a.m."]));
  });

  it("schedule refuses incomplete releases and caches the subscriber count", async () => {
    const v = await createRelease(db(), { ...sampleCreate, sectors: [] }, editor);
    const a = await approve(db(), v.id, v.version, editor, deps);
    await expect(schedule(db(), v.id, { version: a.version, publishAt: "now" }, editor, deps)).rejects.toEqual(new ReleaseRuleError(["Choose at least one sector."]));
    const fixed = await saveCategories(db(), v.id, { version: a.version, leadMinistryKey: "health", ministries: ["health"], sectors: ["health"], themes: [], tags: [] }, editor);
    let seen: string[] = [];
    const s = await schedule(db(), v.id, { version: fixed.version, publishAt: "now" }, editor, { timeZone: TZ, countSubscribers: async (k) => ((seen = k), 42) });
    expect(seen).toEqual(["ministries:health", "sectors:health"]);
    expect(s.nodSubscribers).toBe(42);
  });

  it("schedule: a time up to 5 min past is immediate; a failed count never blocks; a re-publish keeps its count", async () => {
    const v = await createRelease(db(), sampleCreate, editor);
    const a = await approve(db(), v.id, v.version, editor, deps);
    const failing = { timeZone: TZ, countSubscribers: async () => { throw new Error("down"); } };
    const s = await schedule(db(), v.id, { version: a.version, publishAt: new Date(Date.now() - 2 * 60_000).toISOString() }, editor, failing);
    expect(s.status).toBe("scheduled");
    expect(new Date(s.publishAt!).getUTCSeconds()).toBe(0);
    expect(s.nodSubscribers).toBeNull();
    // Unpublished earlier: back to approved, released_at kept — scheduling again is a re-publish.
    await tdb.db.execute(sql`UPDATE news_releases SET status = 'approved', released_at = now(), nod_subscribers = 7 WHERE id = ${v.id}`);
    let called = false;
    const again = await schedule(db(), v.id, { version: (await loadView(db(), v.id))!.version, publishAt: "now" }, editor, { timeZone: TZ, countSubscribers: async () => ((called = true), 99) });
    expect(again.status).toBe("scheduled");
    expect(called).toBe(false);
    expect(again.nodSubscribers).toBe(7);
    const log = await tdb.db.execute<{ text: string }>(sql`SELECT text FROM release_log WHERE release_id = ${v.id} ORDER BY id`);
    expect(log.rows.map((r) => r.text)).toEqual(["Created Release", "Approved Release", "Scheduled for Immediate Release", "Scheduled for Immediate Release"]);
  });

  it("unpublish: only live releases, never advisories", async () => {
    const v = await createRelease(db(), sampleCreate, editor);
    const a = await approve(db(), v.id, v.version, editor, deps);
    await expect(unpublish(db(), v.id, a.version, editor)).rejects.toBeInstanceOf(ReleaseStateError);
    await tdb.db.execute(sql`UPDATE news_releases SET status = 'published', publish_at = now(), released_at = now() WHERE id = ${v.id}`);
    const live = (await loadView(db(), v.id))!;
    expect((await unpublish(db(), v.id, live.version, editor)).status).toBe("unpublishing");
    const adv = await createRelease(db(), { ...sampleCreate, type: "advisory", sectors: [], mediaListKeys: ["regional"] }, editor);
    await tdb.db.execute(sql`UPDATE news_releases SET status = 'published', publish_at = now(), released_at = now() WHERE id = ${adv.id}`);
    await expect(unpublish(db(), adv.id, (await loadView(db(), adv.id))!.version, editor)).rejects.toEqual(new ReleaseStateError("A sent Advisory can't be unpublished."));
  });
});
