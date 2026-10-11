import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import type { Request } from "express";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintSession } from "@gcpe/auth";
import { createNrmsTestDb, sampleCreate, seedActivity, seedTaxonomy } from "../../test/helpers";
import { createApp } from "../app";
import { calendarViewers, organizations } from "../db/schema";
import { bcDateOf, lookupActivity } from "./lookup";
import { calendarViewerOf } from "./viewer";

const SECRET = "z".repeat(40) + "-calendar-lookup";
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PEOPLE = {
  hqReader: { id: uid(701), role: "Calendar.ReadOnly", orgs: ["gcpe-hq"] },
  healthEditor: { id: uid(702), role: "Calendar.Editor", orgs: ["health"] },
  financeReader: { id: uid(703), role: "Calendar.ReadOnly", orgs: ["finance"] },
  noRole: { id: uid(704), role: null, orgs: ["gcpe-hq"] },
  inactive: { id: uid(705), role: "Calendar.Administrator", orgs: ["gcpe-hq"], isActive: false },
  hqAdmin: { id: uid(706), role: "Calendar.Administrator", orgs: ["gcpe-hq"] },
} as const;
type Who = keyof typeof PEOPLE | "unknown";

describe("the release editor's activity lookup and the link it saves (spec addendum §11, C142)", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  const cookies = {} as Record<Who, string>;
  const lookup = (id: string | number, who: Who = "hqReader") => request(app).get(`/api/calendar-activities/${id}`).set("cookie", cookies[who]);
  const post = (path: string, body: object, method: "post" | "put" = "post") => request(app)[method](`/api${path}`).set("cookie", cookies.hqReader).set("x-gcpe-request", "1").send(body);

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
    await tdb.db.insert(organizations).values({ key: "gcpe-hq", displayName: "Sample HQ", abbreviation: "HQ", isHq: true });
    await tdb.db.insert(organizations).values({ key: "retired", displayName: "Sample Retired", abbreviation: "RET", isActive: false });
    for (const p of Object.values(PEOPLE)) {
      await tdb.db.insert(calendarViewers).values({ userId: p.id, isActive: "isActive" in p ? p.isActive : true, calendarRole: p.role, organizationKeys: [...p.orgs] });
    }
    app = createApp({ db: tdb.db, auth: { session: { secret: SECRET } }, eventSecrets: {}, workflow: { timeZone: "America/Vancouver" }, forecastCategoryPrefix: "Approved" });
    const cookieOf = async (id: string) => `gcpe_session=${(await mintSession(SECRET, { id, name: "Sample Person", email: "person@example.test", roles: ["NRMS.Editor"] })).token}`;
    for (const [who, p] of Object.entries(PEOPLE)) cookies[who as Who] = await cookieOf(p.id);
    cookies.unknown = await cookieOf(uid(799));
    await seedActivity(tdb.db, 5001, {
      title: "Sample clinic opening", contactMinistryKey: "health", sharedMinistryKeys: ["finance", "retired"], cityName: "Victoria, BC",
      sectorKeys: ["health", "no-such-sector"], themeKeys: ["families"], tagKeys: ["covid-19"], translations: ["French"],
    });
    await seedActivity(tdb.db, 5002, { isConfidential: true, title: null, details: null, startAt: null, endAt: null, isAllDay: null, isConfirmed: null, contactMinistryKey: null, cityName: null, categoryNames: [], sectorKeys: [] });
    await seedActivity(tdb.db, 5003, { isDeleted: true });
    await seedActivity(tdb.db, 5004, { contactMinistryKey: "education" });
    await seedActivity(tdb.db, 5005, { categoryNames: ["Proposed Event"] });
    await seedActivity(tdb.db, 5006, { startAt: new Date("2020-06-11T17:00:00Z"), endAt: new Date("2020-06-11T18:00:00Z") });
    await seedActivity(tdb.db, 5007, { contactMinistryKey: "HEALTH" });
  });
  afterAll(() => tdb.drop());

  it("an eligible activity offers legacy's pre-fill, in NRMS's own keys, and its Translations as required", async () => {
    const res = await lookup(5001);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: 5001, state: "found", title: "Sample clinic opening", startAt: "2031-06-11T17:00:00.000Z", endAt: "2031-06-11T18:00:00.000Z",
      ministryName: "Health", location: "Victoria", translations: ["French"], notEligible: null,
      prefill: {
        publishAt: "2031-06-11T17:00:00.000Z", location: "Victoria", ministries: ["health", "finance"], leadMinistryKey: "health",
        sectors: ["health"], themes: ["families"], tags: ["covid-19"],
      },
    });
  });

  it("follows the Calendar's visibility: own or shared ministry, or HQ", async () => {
    expect((await lookup(5001, "healthEditor")).body.state).toBe("found");
    expect((await lookup(5001, "financeReader")).body.state).toBe("found");
    expect((await lookup(5004, "healthEditor")).body).toEqual({ id: 5004, state: "hidden" });
    expect((await lookup(5004, "hqReader")).body.state).toBe("found");
  });

  it("Core keys compare byte for byte, as in the Calendar; the pre-fill turns them into NRMS's lowercase keys", async () => {
    expect((await lookup(5007, "healthEditor")).body.state).toBe("hidden");
    expect((await lookup(5007, "hqReader")).body.prefill).toMatchObject({ ministries: ["health"], leadMinistryKey: "health" });
  });

  it("someone with no Calendar access learns only that the id exists", async () => {
    for (const who of ["noRole", "inactive", "unknown"] as const) expect((await lookup(5001, who)).body).toEqual({ id: 5001, state: "hidden" });
  });

  it("a confidential activity is hidden even from an HQ Administrator: NRMS holds no detail of it (C127)", async () => {
    expect((await lookup(5002, "hqAdmin")).body).toEqual({ id: 5002, state: "hidden" });
  });

  it("deleted and unknown ids say so, and pre-fill nothing", async () => {
    expect((await lookup(5003)).body).toEqual({ id: 5003, state: "deleted" });
    expect((await lookup(9999)).body).toEqual({ id: 9999, state: "unknown" });
  });

  it("a category not starting \"Approved\", or an activity that has ended, shows its details but pre-fills nothing", async () => {
    expect((await lookup(5005)).body).toMatchObject({ state: "found", prefill: null, notEligible: "Nothing is filled in: its category doesn't start with “Approved”." });
    expect((await lookup(5006)).body).toMatchObject({ state: "found", prefill: null, notEligible: "Nothing is filled in: it has ended." });
  });

  it("an activity ending today, BC time, can still be planned against; from tomorrow it can't (News/Services.asmx.cs:87)", async () => {
    const viewer = { level: 1, isHq: true, ministryKeys: ["gcpe-hq"] };
    const opts = { prefix: "Approved", timeZone: "America/Vancouver" };
    // 5001 ends 2031-06-11 11:00 BC (UTC−7).
    expect(await lookupActivity(tdb.db, viewer, 5001, { ...opts, nowMs: Date.parse("2031-06-12T06:59:00Z") })).toMatchObject({ state: "found", notEligible: null });
    expect(await lookupActivity(tdb.db, viewer, 5001, { ...opts, nowMs: Date.parse("2031-06-12T07:01:00Z") })).toMatchObject({ prefill: null, notEligible: "Nothing is filled in: it has ended." });
    expect(bcDateOf(Date.parse("2031-06-12T06:59:00Z"), "America/Vancouver")).toBe("2031-06-11");
  });

  it("a malformed or out-of-range id is not found, never a 500", async () => {
    for (const id of ["0", "abc", "-1", "2147483648", "12345678901", "1.5"]) expect((await lookup(id)).status).toBe(404);
  });

  it("only a staff session has Calendar visibility in NRMS: a bearer token sees no activity", async () => {
    const req = (via: string) => ({ auth: { subject: PEOPLE.hqReader.id, roles: ["NRMS.Editor"], claims: { via } } }) as unknown as Request;
    expect(await calendarViewerOf(tdb.db, req("session"))).toEqual({ level: 1, isHq: true, ministryKeys: ["gcpe-hq"] });
    expect(await calendarViewerOf(tdb.db, req("bearer"))).toBeNull();
  });

  it("saving: a new id must be known and not deleted; a confidential one can be linked; a stored legacy id stands until changed", async () => {
    expect((await post("/releases", { ...sampleCreate, activityId: 9999 })).body).toMatchObject({ problems: ["No Calendar activity has ID 9999."] });
    expect((await post("/releases", { ...sampleCreate, activityId: 5003 })).body).toMatchObject({ problems: ["Calendar activity 5003 has been deleted."] });
    const linked = await post("/releases", { ...sampleCreate, activityId: 5002 });
    expect(linked.status).toBe(201);
    // As the Phase 3 importer leaves a release linked to an activity that wasn't migrated (C158).
    await tdb.db.execute(sql`UPDATE news_releases SET activity_id = 777000 WHERE id = ${linked.body.id}`);
    const settings = { plannedPublishAt: null, toSubscribers: false, toMediaLists: false, mediaListKeys: [] };
    const kept = await post(`/releases/${linked.body.id}/settings`, { ...settings, version: linked.body.version, activityId: 777000 }, "put");
    expect(kept.status).toBe(200);
    const changed = await post(`/releases/${linked.body.id}/settings`, { ...settings, version: kept.body.version, activityId: 777001 }, "put");
    expect(changed.status).toBe(422);
    expect(changed.body.problems).toEqual(["No Calendar activity has ID 777001."]);
  });
});
