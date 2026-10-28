import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintSession } from "@gcpe/auth";
import type { EventEnvelope, OrgSucceeded } from "@gcpe/events";
import { createNrmsTestDb, editor, sampleCreate, seedTaxonomy } from "../test/helpers";
import { createApp } from "./app";
import { organizations } from "./db/schema";
import { createRelease } from "./releases/service";
import { approve } from "./releases/workflow";
import { bcYear } from "./releases/numbering";
import { approveProblems } from "@gcpe/nrms-contract";
import { loadView } from "./releases/store";
import { successionHandler } from "./succession";

const TZ = "America/Vancouver";
const SECRET = "s".repeat(40) + "-nrms-succession-test";
const AT = "2028-11-20T17:00:00.000Z";
const data = (over: Partial<OrgSucceeded> = {}): OrgSucceeded => ({ key: "health", successorKeys: ["wellness"], moveSubscribers: true, moveCalendar: true, moveDrafts: true, takeAbbreviation: true, at: AT, ...over });
const ev = (d: OrgSucceeded, source = "core") => ({ id: crypto.randomUUID(), type: "org.succeeded", source, aggregateId: `org-succession:${d.key}`, sequence: 1, occurredAt: AT, data: d }) as unknown as EventEnvelope;

describe("NRMS org.succeeded", () => {
  let tdb: TestDatabase;
  const apply = (d: OrgSucceeded) => tdb.db.transaction(async (tx) => successionHandler(ev(d))!(tx, ev(d)));
  const draft = async (over: Record<string, unknown> = {}) => createRelease(tdb.db, { ...sampleCreate, ...over }, editor);
  const leadOf = async (id: string) => (await tdb.pool.query("SELECT lead_ministry_key AS k FROM news_releases WHERE id = $1", [id])).rows[0].k as string | null;
  const cats = async (id: string) => (await tdb.pool.query("SELECT key FROM release_categories WHERE release_id = $1 AND kind = 'ministries' ORDER BY key", [id])).rows.map((r: { key: string }) => r.key);

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE news_releases, number_counters, organizations CASCADE");
    await seedTaxonomy(tdb.db);
    await tdb.db.insert(organizations).values({ key: "wellness", displayName: "Wellness", abbreviation: "HLTH", sortOrder: 3 });
  });

  it("ignores other sources and types", () => {
    expect(successionHandler({ ...ev(data()), source: "nrms" } as EventEnvelope)).toBeUndefined();
    expect(successionHandler({ ...ev(data()), type: "org.upserted" } as EventEnvelope)).toBeUndefined();
  });

  it("re-points drafts only", async () => {
    const d = await draft();
    const other = await draft({ ministries: ["health", "finance"], leadMinistryKey: "finance" });
    const a = await draft();
    await approve(tdb.db, a.id, a.version, editor, { timeZone: TZ });
    await apply(data());
    expect(await leadOf(d.id)).toBe("wellness");
    expect(await cats(d.id)).toEqual(["wellness"]);
    expect(await leadOf(other.id)).toBe("finance");
    expect(await cats(other.id)).toEqual(["finance", "wellness"]);
    expect(await leadOf(a.id)).toBe("health");
    expect(await cats(a.id)).toEqual(["health"]);
  });

  it("leaves drafts alone when moveDrafts is off", async () => {
    const d = await draft();
    await apply(data({ moveDrafts: false }));
    expect(await leadOf(d.id)).toBe("health");
    expect(await cats(d.id)).toEqual(["health"]);
  });

  it("collapses to one row when the draft already lists the successor", async () => {
    const d = await draft({ ministries: ["health", "wellness"], leadMinistryKey: "health" });
    await apply(data());
    expect(await cats(d.id)).toEqual(["wellness"]);
    expect(await leadOf(d.id)).toBe("wellness");
  });

  const approveAs = async (lead: string) => {
    const d = await draft({ ministries: [lead], leadMinistryKey: lead });
    await approve(tdb.db, d.id, d.version, editor, { timeZone: TZ });
    return (await tdb.pool.query("SELECT ministry_release AS n, key FROM news_releases WHERE id = $1", [d.id])).rows[0] as { n: number; key: string };
  };
  const dbYear = async () => bcYear((await tdb.pool.query("SELECT now() AS now")).rows[0].now as Date, TZ);

  it("a successor taking the abbreviation continues the count, whichever event or approval comes first", async () => {
    const year = await dbYear();
    for (let i = 1; i <= 3; i++) expect((await approveAs("health")).n).toBe(i);
    // B already holds HLTH locally (org.upserted arrived before org.succeeded), A is deactivated: B continues at 4.
    await tdb.pool.query("UPDATE organizations SET is_active = false WHERE key = 'health'");
    const first = await approveAs("wellness");
    expect(first.n).toBe(4);
    expect(first.key).toMatch(new RegExp(`^${year}HLTH0004-`));
    await apply(data()); // the hand-over event, arriving late, changes nothing about numbering
    await apply(data());
    expect((await approveAs("wellness")).n).toBe(5);
  });

  it("an abbreviation with stray spaces (legacy Core import) numbers under the trimmed one", async () => {
    const year = await dbYear();
    await approveAs("health");
    await tdb.pool.query("UPDATE organizations SET abbreviation = 'WELL' WHERE key = 'wellness'");
    await tdb.pool.query("UPDATE organizations SET is_active = false WHERE key = 'health'");
    await tdb.db.insert(organizations).values({ key: "spaced", displayName: "Spaced", abbreviation: " hlth ", sortOrder: 4 });
    const next = await approveAs("spaced");
    expect(next.n).toBe(2);
    expect(next.key).toMatch(new RegExp(`^${year}HLTH0002-`));
  });

  it("an abbreviation freed and taken again never restarts at 0001 within the year", async () => {
    await approveAs("health");
    await approveAs("health");
    await tdb.pool.query("UPDATE organizations SET abbreviation = 'WELL' WHERE key = 'wellness'");
    await tdb.pool.query("UPDATE organizations SET is_active = false WHERE key = 'health'");
    await tdb.db.insert(organizations).values({ key: "newcomer", displayName: "Newcomer", abbreviation: "hlth", sortOrder: 4 });
    expect((await approveAs("newcomer")).n).toBe(3); // a lower-case abbreviation counts as HLTH
    expect((await approveAs("wellness")).n).toBe(1); // WELL has its own count
  });

  it("finds the inactive lead whatever the lead key's case, as numbering does", async () => {
    const d = await draft();
    await tdb.pool.query("UPDATE news_releases SET lead_ministry_key = 'HEALTH' WHERE id = $1", [d.id]);
    await tdb.pool.query("UPDATE organizations SET is_active = false WHERE key = 'health'");
    await expect(approve(tdb.db, d.id, d.version, editor, { timeZone: TZ })).rejects.toMatchObject({
      problems: ["This ministry is no longer active. Change the lead ministry to its successor before approving."],
    });
  });

  it("refuses to approve a release led by a succeeded (inactive) ministry", async () => {
    const d = await draft();
    await tdb.pool.query("UPDATE organizations SET is_active = false WHERE key = 'health'");
    await expect(approve(tdb.db, d.id, d.version, editor, { timeZone: TZ })).rejects.toMatchObject({
      problems: ["This ministry is no longer active. Change the lead ministry to its successor before approving."],
    });
    expect((await tdb.pool.query("SELECT status FROM news_releases WHERE id = $1", [d.id])).rows[0].status).toBe("draft");
    expect(approveProblems({ ...(await loadView(tdb.db, d.id))!, leadMinistryKey: "health" }, ["health"])).toHaveLength(1);
    // After the hand-over moves the draft, it approves under the successor.
    await apply(data());
    const fresh = (await tdb.pool.query("SELECT version FROM news_releases WHERE id = $1", [d.id])).rows[0].version as number;
    await approve(tdb.db, d.id, fresh, editor, { timeZone: TZ });
    expect(await leadOf(d.id)).toBe("wellness");
  });

  it("a redelivery changes nothing", async () => {
    const d = await draft();
    await apply(data());
    const v1 = (await tdb.pool.query("SELECT version FROM news_releases WHERE id = $1", [d.id])).rows[0].version;
    await apply(data());
    expect(await leadOf(d.id)).toBe("wellness");
    expect(await cats(d.id)).toEqual(["wellness"]);
    expect((await tdb.pool.query("SELECT version FROM news_releases WHERE id = $1", [d.id])).rows[0].version).toBe(v1);
  });

  it("leaves a published release that lists the ministry (not as lead) alone", async () => {
    const p = await draft({ ministries: ["finance", "health"], leadMinistryKey: "finance" });
    await approve(tdb.db, p.id, p.version, editor, { timeZone: TZ });
    await tdb.pool.query("UPDATE news_releases SET status = 'published', publish_at = now() WHERE id = $1", [p.id]);
    await apply(data());
    expect(await cats(p.id)).toEqual(["finance", "health"]);
    expect(await leadOf(p.id)).toBe("finance");
  });

  describe("GET /api/ministries/:key/open-releases", () => {
    const cookie = async (roles: string[]) => `gcpe_session=${(await mintSession(SECRET, { id: "00000000-0000-4000-8000-00000000000c", name: "Ada", email: "ada@example.invalid", roles })).token}`;
    const app = () => createApp({ db: tdb.db, auth: { session: { secret: SECRET } }, eventSecrets: {}, workflow: { timeZone: TZ } });

    it("lists drafts and notMoved (approved, scheduled, publishing) led by the ministry", async () => {
      const d = await draft({ headline: "A draft" });
      const a = await draft({ headline: "An approved one" });
      await approve(tdb.db, a.id, a.version, editor, { timeZone: TZ });
      const s = await draft({ headline: "A publishing one" });
      await approve(tdb.db, s.id, s.version, editor, { timeZone: TZ });
      await tdb.pool.query("UPDATE news_releases SET status = 'publishing', publish_at = now() WHERE id = $1", [s.id]);
      const sc = await draft({ headline: "A scheduled one" });
      await approve(tdb.db, sc.id, sc.version, editor, { timeZone: TZ });
      await tdb.pool.query("UPDATE news_releases SET status = 'scheduled', publish_at = now() + interval '1 day' WHERE id = $1", [sc.id]);
      const listed = await draft({ ministries: ["finance", "health"], leadMinistryKey: "finance", headline: "Lists it only" });
      const pub = await draft({ headline: "Done" });
      await approve(tdb.db, pub.id, pub.version, editor, { timeZone: TZ });
      await tdb.pool.query("UPDATE news_releases SET status = 'published', publish_at = now() WHERE id = $1", [pub.id]);
      await draft({ ministries: ["finance"], leadMinistryKey: "finance", headline: "Elsewhere" });

      const res = await request(app()).get("/api/ministries/health/open-releases").set("cookie", await cookie(["Core.Admin"]));
      expect(res.status).toBe(200);
      expect(res.body.drafts).toEqual([{ id: d.id, headline: "A draft" }, { id: listed.id, headline: "Lists it only" }]);
      expect(res.body.notMoved.map((r: { headline: string; status: string; key: string }) => [r.headline, r.status, typeof r.key]).sort()).toEqual([["A publishing one", "publishing", "string"], ["A scheduled one", "scheduled", "string"], ["An approved one", "approved", "string"]]);
      expect((await request(app()).get("/api/ministries/health/open-releases").set("cookie", await cookie(["NRMS.Editor"]))).status).toBe(403);
    });
  });
});
