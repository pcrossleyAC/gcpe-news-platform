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
import { successionHandler } from "./succession";

const TZ = "America/Vancouver";
const SECRET = "s".repeat(40) + "-nrms-succession-test";
const AT = "2028-11-20T17:00:00.000Z";
const data = (over: Partial<OrgSucceeded> = {}): OrgSucceeded => ({ key: "health", successorKeys: ["wellness"], moveSubscribers: true, moveCalendar: true, moveDrafts: true, takeAbbreviation: true, at: AT, ...over });
const ev = (d: OrgSucceeded, source = "core") => ({ id: crypto.randomUUID(), type: "org.succeeded", source, aggregateId: d.key, sequence: 1, occurredAt: AT, data: d }) as unknown as EventEnvelope;

describe("NRMS org.succeeded", () => {
  let tdb: TestDatabase;
  const apply = (d: OrgSucceeded) => tdb.db.transaction(async (tx) => successionHandler(ev(d))!(tx, ev(d)));
  const draft = async (over: Record<string, unknown> = {}) => createRelease(tdb.db, { ...sampleCreate, ...over }, editor);
  const leadOf = async (id: string) => (await tdb.pool.query("SELECT lead_ministry_key AS k FROM news_releases WHERE id = $1", [id])).rows[0].k as string | null;
  const cats = async (id: string) => (await tdb.pool.query("SELECT key FROM release_categories WHERE release_id = $1 AND kind = 'ministries' ORDER BY key", [id])).rows.map((r: { key: string }) => r.key);
  const counter = async (m: string) => (await tdb.pool.query("SELECT last_value FROM number_counters WHERE scope = 'ministry' AND year = $1 AND ministry = $2", [bcYear(new Date(AT), TZ), m])).rows[0]?.last_value as number | undefined;

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

  it("seeds the successor counter so the next number continues", async () => {
    const now = new Date().toISOString(); // approve numbers by the clock's year, so the hand-over is dated now
    const year = bcYear(new Date(now), TZ);
    await tdb.pool.query("INSERT INTO number_counters (scope, year, ministry, last_value) VALUES ('ministry', $1, 'health', 41)", [year]);
    const d = await draft();
    await apply(data({ at: now }));
    expect((await tdb.pool.query("SELECT last_value FROM number_counters WHERE scope = 'ministry' AND year = $1 AND ministry = 'wellness'", [year])).rows[0].last_value).toBe(41);
    const fresh = (await tdb.pool.query("SELECT version FROM news_releases WHERE id = $1", [d.id])).rows[0].version as number;
    expect(fresh).toBe(d.version + 1); // the hand-over bumps the version, so an editor's stale copy conflicts instead of undoing it
    await approve(tdb.db, d.id, fresh, editor, { timeZone: TZ });
    const r = (await tdb.pool.query("SELECT ministry_release, key FROM news_releases WHERE id = $1", [d.id])).rows[0];
    expect(r.ministry_release).toBe(42);
    expect(r.key).toMatch(new RegExp(`^${year}HLTH0042-`));
  });

  it("never lowers a successor counter that is already ahead, and skips when takeAbbreviation is off", async () => {
    const year = bcYear(new Date(AT), TZ);
    await tdb.pool.query("INSERT INTO number_counters (scope, year, ministry, last_value) VALUES ('ministry', $1, 'health', 10), ('ministry', $1, 'wellness', 25)", [year]);
    await apply(data());
    expect(await counter("wellness")).toBe(25);
    await tdb.pool.query("DELETE FROM number_counters WHERE ministry = 'wellness'");
    await apply(data({ takeAbbreviation: false }));
    expect(await counter("wellness")).toBeUndefined();
  });

  it("is idempotent on redelivery", async () => {
    const year = bcYear(new Date(AT), TZ);
    await tdb.pool.query("INSERT INTO number_counters (scope, year, ministry, last_value) VALUES ('ministry', $1, 'health', 41)", [year]);
    const d = await draft();
    await apply(data());
    const v1 = (await tdb.pool.query("SELECT version FROM news_releases WHERE id = $1", [d.id])).rows[0].version;
    await tdb.pool.query("UPDATE number_counters SET last_value = 44 WHERE ministry = 'wellness'"); // successor has since issued numbers
    await apply(data());
    expect(await leadOf(d.id)).toBe("wellness");
    expect(await cats(d.id)).toEqual(["wellness"]);
    expect((await tdb.pool.query("SELECT version FROM news_releases WHERE id = $1", [d.id])).rows[0].version).toBe(v1);
    expect(await counter("wellness")).toBe(44);
  });

  describe("GET /api/ministries/:key/open-releases", () => {
    const cookie = async (roles: string[]) => `gcpe_session=${(await mintSession(SECRET, { id: "00000000-0000-4000-8000-00000000000c", name: "Ada", email: "ada@example.invalid", roles })).token}`;
    const app = () => createApp({ db: tdb.db, auth: { session: { secret: SECRET } }, eventSecrets: {}, workflow: { timeZone: TZ } });

    it("lists drafts and notMoved (approved, scheduled, publishing) led by the ministry", async () => {
      const d = await draft({ headline: "A draft" });
      const a = await draft({ headline: "An approved one" });
      await approve(tdb.db, a.id, a.version, editor, { timeZone: TZ });
      const s = await draft({ headline: "A scheduled one" });
      await approve(tdb.db, s.id, s.version, editor, { timeZone: TZ });
      await tdb.pool.query("UPDATE news_releases SET status = 'publishing', publish_at = now() WHERE id = $1", [s.id]);
      const pub = await draft({ headline: "Done" });
      await approve(tdb.db, pub.id, pub.version, editor, { timeZone: TZ });
      await tdb.pool.query("UPDATE news_releases SET status = 'published', publish_at = now() WHERE id = $1", [pub.id]);
      await draft({ ministries: ["finance"], leadMinistryKey: "finance", headline: "Elsewhere" });

      const res = await request(app()).get("/api/ministries/health/open-releases").set("cookie", await cookie(["Core.Admin"]));
      expect(res.status).toBe(200);
      expect(res.body.drafts).toEqual([{ id: d.id, headline: "A draft" }]);
      expect(res.body.notMoved.map((r: { headline: string; status: string; key: string }) => [r.headline, r.status, typeof r.key]).sort()).toEqual([["A scheduled one", "publishing", "string"], ["An approved one", "approved", "string"]]);
      expect((await request(app()).get("/api/ministries/health/open-releases").set("cookie", await cookie(["NRMS.Editor"]))).status).toBe(403);
    });
  });
});
