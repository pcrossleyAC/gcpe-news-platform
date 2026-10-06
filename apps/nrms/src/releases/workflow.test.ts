import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNrmsTestDb, editor, sampleCreate, seedTaxonomy } from "../../test/helpers";
import { governmentTerms } from "../db/schema";
import { ReleaseRuleError, ReleaseStateError, ReleaseTooLargeError } from "./errors";
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

  it("a number already in use at approve → ReleaseStateError (409), not a 500", async () => {
    const a = await createRelease(db(), sampleCreate, editor);
    await approve(db(), a.id, a.version, editor, deps);
    await tdb.db.execute(sql`UPDATE number_counters SET last_value = last_value - 1 WHERE scope = 'news'`);
    try {
      const b = await createRelease(db(), sampleCreate, editor);
      await expect(approve(db(), b.id, b.version, editor, deps)).rejects.toEqual(new ReleaseStateError("That number is already in use — try again."));
      expect((await loadView(db(), b.id))!.status).toBe("draft");
    } finally {
      await tdb.db.execute(sql`UPDATE number_counters SET last_value = last_value + 1 WHERE scope = 'news'`);
    }
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

  // Fix round 1 (3f Task 3), finding 3: the server does the DST-aware conversion for
  // `publishAtLocal` with its own tzdata — a stale browser can no longer get this wrong.
  it("schedule accepts publishAtLocal (BC wall-clock, no offset) and converts it with the server's own tzdata", async () => {
    const v = await createRelease(db(), sampleCreate, editor);
    const a = await approve(db(), v.id, v.version, editor, deps);
    const future = await schedule(db(), v.id, { version: a.version, publishAtLocal: "2030-06-15T10:30" }, editor, deps);
    expect(future.publishAt).toBe("2030-06-15T17:30:00.000Z"); // 10:30 PDT (UTC-7) -> 17:30Z
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

  it("schedule caches the media contact count, prefixed for NoD, only when toMediaLists is set with lists chosen", async () => {
    const v = await createRelease(db(), { ...sampleCreate, mediaListKeys: ["regional", "national"] }, editor);
    const a = await approve(db(), v.id, v.version, editor, deps);
    let seen: string[] = [];
    const s = await schedule(db(), v.id, { version: a.version, publishAt: "now" }, editor, { timeZone: TZ, countMediaContacts: async (k) => ((seen = k), 7) });
    expect(seen).toEqual(["media-distribution-lists:regional", "media-distribution-lists:national"]);
    expect(s.mediaSubscribers).toBe(7);
  });

  it("schedule never calls countMediaContacts without toMediaLists and chosen lists", async () => {
    const v = await createRelease(db(), sampleCreate, editor);
    const a = await approve(db(), v.id, v.version, editor, deps);
    let called = false;
    const s = await schedule(db(), v.id, { version: a.version, publishAt: "now" }, editor, { timeZone: TZ, countMediaContacts: async () => ((called = true), 99) });
    expect(called).toBe(false);
    expect(s.mediaSubscribers).toBeNull();
  });

  // Fix round 1: the two prior tests only vary toMediaLists and mediaListKeys together (today's
  // only settings-path combinations -- saveSettings derives toMediaLists from
  // mediaListKeys.length itself, service.ts, so an editor can never submit one without the
  // other). This exercises the two checks in mediaContactCount's gate independently: lists are
  // chosen, but toMediaLists is off (set directly, since the app has no path that reaches this
  // combination on its own -- same as the raw SQL used below to set up nod_subscribers states no
  // mutation leaves behind).
  it("schedule never calls countMediaContacts when toMediaLists is off, even with media lists chosen", async () => {
    const v = await createRelease(db(), { ...sampleCreate, mediaListKeys: ["regional"] }, editor);
    const a = await approve(db(), v.id, v.version, editor, deps);
    await tdb.db.execute(sql`UPDATE news_releases SET to_media_lists = false WHERE id = ${v.id}`);
    let called = false;
    const s = await schedule(db(), v.id, { version: a.version, publishAt: "now" }, editor, { timeZone: TZ, countMediaContacts: async () => ((called = true), 99) });
    expect(called).toBe(false);
    expect(s.mediaSubscribers).toBeNull();
  });

  it("schedule: a failed media contact count never blocks scheduling and gives null", async () => {
    const v = await createRelease(db(), { ...sampleCreate, mediaListKeys: ["regional"] }, editor);
    const a = await approve(db(), v.id, v.version, editor, deps);
    const failing = { timeZone: TZ, countMediaContacts: async () => { throw new Error("down"); } };
    const s = await schedule(db(), v.id, { version: a.version, publishAt: "now" }, editor, failing);
    expect(s.status).toBe("scheduled");
    expect(s.mediaSubscribers).toBeNull();
  });

  // Controller ruling: schedule's size pre-check must count mediaText too (the same rendition
  // the publisher itself fills it with) -- a body that fits without it but not with it must be
  // rejected here, before it can later blow past MAX_EVENT_BYTES at actual publish time.
  it("the schedule-time size check counts mediaText, rejecting a media release that only fits without it", async () => {
    const bigBody = `<p>${"x".repeat(600_000)}</p>`;
    const v = await createRelease(db(), { ...sampleCreate, bodyHtml: bigBody, mediaListKeys: ["regional"] }, editor);
    const a = await approve(db(), v.id, v.version, editor, deps);
    await expect(schedule(db(), v.id, { version: a.version, publishAt: "now" }, editor, deps)).rejects.toBeInstanceOf(ReleaseTooLargeError);
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
    await tdb.db.execute(sql`UPDATE news_releases SET status = 'published', publish_at = now(), released_at = now(), live = true WHERE id = ${v.id}`);
    const live = (await loadView(db(), v.id))!;
    expect((await unpublish(db(), v.id, live.version, editor)).status).toBe("unpublishing");
    const adv = await createRelease(db(), { ...sampleCreate, type: "advisory", sectors: [], mediaListKeys: ["regional"] }, editor);
    await tdb.db.execute(sql`UPDATE news_releases SET status = 'published', publish_at = now(), released_at = now(), live = true WHERE id = ${adv.id}`);
    await expect(unpublish(db(), adv.id, (await loadView(db(), adv.id))!.version, editor)).rejects.toEqual(new ReleaseStateError("A sent Advisory can't be unpublished."));
  });
});
