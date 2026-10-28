import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintSession } from "@gcpe/auth";
import { createNrmsTestDb, createScheduledRelease } from "../../test/helpers";
import { createApp } from "../app";
import { governmentTerms } from "../db/schema";
import { GOVERNMENT_TERMS_LOCK } from "../government-terms";

const SECRET = "z".repeat(40) + "-nrms-government-terms-test";
// Noon Pacific on 2026-12-15 under either PST or the permanent UTC-7 (tzdata 2026): far from any day boundary.
const NOW = new Date("2026-12-15T20:00:00Z");
const TODAY = "2026-12-15";
const SUBS = [{ name: "news", url: "http://news.invalid/events", secret: "s".repeat(40), types: ["*"] }];

describe("NRMS government-term admin API", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let admin: string;
  let editor: string;

  const cookieFor = async (roles: string[]) =>
    `gcpe_session=${(await mintSession(SECRET, { id: "00000000-0000-4000-8000-00000000000c", name: "Ada Admin", email: "ada@example.invalid", roles })).token}`;
  const get = (cookie = admin) => request(app).get("/api/government-terms").set("cookie", cookie);
  const post = (body: unknown, cookie = admin) => request(app).post("/api/government-terms").set("cookie", cookie).set("x-gcpe-request", "1").send(body as object);
  const patch = (id: string, body: unknown, cookie = admin) => request(app).patch(`/api/government-terms/${id}`).set("cookie", cookie).set("x-gcpe-request", "1").send(body as object);
  const del = (id: string, cookie = admin) => request(app).delete(`/api/government-terms/${id}`).set("cookie", cookie).set("x-gcpe-request", "1");
  const idOf = async (name: string) => (await tdb.pool.query("SELECT id FROM government_terms WHERE name = $1", [name])).rows[0].id as string;
  const published = async () => (await tdb.pool.query("SELECT envelope->'data' AS data FROM outbox_events WHERE type = 'government_terms.published' ORDER BY sequence")).rows as { data: { currentSlug: string | null } }[];
  const names = async () => (await tdb.pool.query("SELECT name FROM government_terms ORDER BY start_date")).rows.map((r: { name: string }) => r.name);

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    app = createApp({
      db: tdb.db,
      auth: { session: { secret: SECRET } },
      eventSecrets: {},
      workflow: { timeZone: "America/Vancouver" },
      subscribers: SUBS,
      clock: () => NOW,
    });
    admin = await cookieFor(["Core.Admin"]);
    editor = await cookieFor(["NRMS.SiteEditor"]);
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE government_terms, government_terms_published, outbox_events, outbox_deliveries, aggregate_sequences CASCADE");
    await tdb.db.insert(governmentTerms).values([
      { name: "2017-2020", startDate: "2017-07-18" },
      { name: "2020-2024", startDate: "2020-11-02", legacyId: "00000000-0000-4000-8000-0000000000aa" },
      { name: "2024-2028", startDate: "2024-11-18", label: "Eby government" },
    ]);
    // Publish the baseline snapshot so later tests can see what a save adds.
    await post({ startDate: "2099-01-01" }).then((r) => del(r.body.id));
  });

  it("lists terms with status and range", async () => {
    const releaseId = (await createScheduledRelease(tdb.db)).id;
    await tdb.pool.query("UPDATE news_releases SET term_id = $1 WHERE id = $2", [await idOf("2024-2028"), releaseId]);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.today).toBe(TODAY);
    expect(res.body.terms.map((t: { slug: string; status: string; startDate: string; endDate: string | null; releaseCount: number }) => [t.slug, t.status, t.startDate, t.endDate, t.releaseCount])).toEqual([
      ["2024-2028", "current", "2024-11-18", null, 1],
      ["2020-2024", "past", "2020-11-02", "2024-11-17", 0],
      ["2017-2020", "past", "2017-07-18", "2020-11-01", 0],
    ]);
  });

  it("creates a scheduled term and publishes nothing yet", async () => {
    const before = (await published()).length;
    const res = await post({ startDate: "2028-11-20", label: "Next government" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ slug: "2028-11-20", label: "Next government", startDate: "2028-11-20", status: "scheduled", releaseCount: 0 });
    expect((await published()).length).toBe(before);
  });

  it("creates a term dated today and publishes", async () => {
    const before = (await published()).length;
    const res = await post({ startDate: TODAY });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("current");
    const events = await published();
    expect(events.length).toBe(before + 1);
    expect(events.at(-1)!.data.currentSlug).toBe(TODAY);
  });

  it("refuses a start not after the latest", async () => {
    const res = await post({ startDate: "2024-11-17" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "A new term must start after November 18, 2024." });
  });

  it("refuses a date equal to another term's", async () => {
    const res = await post({ startDate: "2024-11-18" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Another term already starts on that date." });
  });

  it("bounds an edit between neighbours", async () => {
    const both = await patch(await idOf("2020-2024"), { startDate: "2024-11-18" });
    expect(both.status).toBe(409);
    expect(both.body).toEqual({ error: "Must be after July 18, 2017 and before November 18, 2024." });
    const oldest = await patch(await idOf("2017-2020"), { startDate: "2020-11-02" });
    expect(oldest.body).toEqual({ error: "Must be before November 2, 2020." });
    const newest = await patch(await idOf("2024-2028"), { startDate: "2020-11-02" });
    expect(newest.body).toEqual({ error: "Must be after November 2, 2020." });
    const ok = await patch(await idOf("2020-2024"), { startDate: "2021-01-05", label: "  Horgan  " });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ startDate: "2021-01-05", label: "Horgan", slug: "2020-2024", endDate: "2024-11-17" });
  });

  it("slug follows date while scheduled; frozen after start", async () => {
    const created = await post({ startDate: "2028-11-20" });
    const moved = await patch(created.body.id, { startDate: "2028-12-01" });
    expect(moved.body).toMatchObject({ slug: "2028-12-01", startDate: "2028-12-01" });
    // An imported (legacy-id) scheduled term keeps its name.
    await tdb.pool.query("UPDATE government_terms SET legacy_id = '00000000-0000-4000-8000-0000000000bb' WHERE id = $1", [created.body.id]);
    expect((await patch(created.body.id, { startDate: "2028-12-02" })).body.slug).toBe("2028-12-01");
    await tdb.pool.query("UPDATE government_terms SET legacy_id = NULL WHERE id = $1", [created.body.id]);
    // Started terms are frozen: editing 2024-2028 never renames it, and neither does a started Hub-made term.
    const started = await post({ startDate: TODAY, label: null });
    expect(started.status).toBe(409); // not after 2028-12-01
    await tdb.pool.query("DELETE FROM government_terms WHERE id = $1", [created.body.id]);
    const now = await post({ startDate: TODAY });
    expect(now.body.status).toBe("current");
    const edited = await patch(now.body.id, { startDate: "2026-12-10" });
    expect(edited.body).toMatchObject({ startDate: "2026-12-10", slug: TODAY });
  });

  it("saving a term whose date flips the public snapshot publishes through the shared path", async () => {
    const created = await post({ startDate: "2028-11-20" });
    const before = (await published()).length;
    // Moving a scheduled term to today makes it current: the snapshot changes.
    const res = await patch(created.body.id, { startDate: TODAY });
    expect(res.body.status).toBe("current");
    const events = await published();
    expect(events.length).toBe(before + 1);
    expect(events.at(-1)!.data.currentSlug).toBe(TODAY);
  });

  it("deletes only scheduled terms", async () => {
    const created = await post({ startDate: "2028-11-20" });
    expect((await del(created.body.id)).status).toBe(204);
    expect(await names()).not.toContain("2028-11-20");
    const current = await del(await idOf("2024-2028"));
    expect(current.status).toBe(409);
    expect(current.body).toEqual({ error: "Only a term that hasn't started can be deleted." });
    expect((await del(await idOf("2017-2020"))).status).toBe(409);
    expect((await del("00000000-0000-4000-8000-0000000000ff")).status).toBe(404);
  });

  it("writes wait for the rollover advisory lock (GOVERNMENT_TERMS_LOCK)", async () => {
    const holder = await tdb.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock($1, $2)", [...GOVERNMENT_TERMS_LOCK]);
      let done = false;
      const pending = post({ startDate: "2028-11-20" }).then((r) => ((done = true), r));
      await new Promise((r) => setTimeout(r, 400));
      expect(done).toBe(false);
      await holder.query("COMMIT");
      expect((await pending).status).toBe(201);
    } finally {
      holder.release();
    }
  });

  it("403 for NRMS.SiteEditor, 401 without a token", async () => {
    expect((await get(editor)).status).toBe(403);
    expect((await post({ startDate: "2030-01-01" }, editor)).status).toBe(403);
    expect((await patch(await idOf("2024-2028"), { label: "x" }, editor)).status).toBe(403);
    expect((await del(await idOf("2024-2028"), editor)).status).toBe(403);
    expect((await request(app).get("/api/government-terms")).status).toBe(401);
  });

  it("400 for http legacy URL (https and null are accepted)", async () => {
    const id = await idOf("2024-2028");
    expect((await patch(id, { legacyArchiveUrl: "http://archive.example.invalid/x.htm" })).status).toBe(400);
    expect((await patch(id, { legacyArchiveUrl: "javascript:alert(1)" })).status).toBe(400);
    expect((await patch(id, { legacyArchiveUrl: "https://archive.example.invalid/x.htm" })).body.legacyArchiveUrl).toBe("https://archive.example.invalid/x.htm");
    expect((await patch(id, { legacyArchiveUrl: null })).body.legacyArchiveUrl).toBeNull();
    expect((await post({ startDate: "2030-02-30" })).status).toBe(400);
  });
});
