import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, inArray, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { listQuerySchema, type ListQueryInput } from "@gcpe/calendar-contract";
import { createCalendarTestDb, createTestApp, FIXED_NOW, projectUser, TEST_RULES } from "../../test/helpers";
import { insertRaw, seedWorld, type Who, type World } from "../../test/world";
import { loadCalendarActor } from "../actor";
import { ActivityForbiddenError } from "../activities/errors";
import { activities, activityCategories, activityInitiatives, activityKeywords, activitySharedWith, cities, favourites } from "../db/schema";
import type { ApiDeps } from "../http/routes";
import { instantOf } from "../time";
import { can } from "../capabilities";
import { visible, visibleSql, type VisibilityFacts } from "../visibility";
import { containsPattern, executiveSummaryShown, idSearchOf, listPageIds } from "./query";

const bc = (date: string, time = "09:00") => instantOf(date, time, TEST_RULES.timeZone);
/** Each test works in a year of its own, so no test sees another's activities. */
const year = (y: number) => ({ from: `${y}-01-01`, to: `${y}-12-31` });
const CONSULT_USER = "00000000-0000-4000-8000-000000000611";

describe("the list query (spec addendum §8.1)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  let deps: ApiDeps;

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
    deps = { db: tdb.db, rules: TEST_RULES, subscribers: [], now: () => FIXED_NOW };
  });
  afterAll(() => tdb.drop());

  async function idsAs(userId: string, q: ListQueryInput, offset = 0) {
    const actor = (await loadCalendarActor(tdb.db, userId))!;
    return listPageIds(deps, actor, listQuerySchema.parse(q), offset);
  }
  const ids = (who: Who, q: ListQueryInput, offset = 0) => idsAs(w.as[who].id, q, offset);
  const only = async (who: Who, q: ListQueryInput) => (await ids(who, q)).ids;

  /** One activity on `date` (BC), 09:00–10:00 unless told otherwise, reviewed, with its join rows. */
  async function act(date: string, o: { end?: string; endTime?: string; cats?: number[]; keywords?: number[]; shared?: string[]; initiatives?: number[]; row?: Partial<typeof activities.$inferInsert> } = {}) {
    const id = await insertRaw(tdb.db, { startAt: bc(date), endAt: bc(o.end ?? date, o.endTime ?? "10:00"), status: "reviewed", ...o.row });
    for (const c of o.cats ?? [w.cat.plain]) await tdb.db.insert(activityCategories).values({ activityId: id, categoryId: c });
    for (const k of o.keywords ?? []) await tdb.db.insert(activityKeywords).values({ activityId: id, keywordId: k });
    for (const m of o.shared ?? []) await tdb.db.insert(activitySharedWith).values({ activityId: id, ministryKey: m });
    for (const i of o.initiatives ?? []) await tdb.db.insert(activityInitiatives).values({ activityId: id, initiativeId: i });
    return id;
  }

  it("starts at today by default and lists what overlaps the range: ongoing activities count, yesterday's don't", async () => {
    await act("2026-11-02");
    const ongoing = await act("2026-10-20", { end: "2026-11-04" });
    const today = await act("2026-11-03");
    const later = await act("2026-11-05");
    await act("2026-11-07");
    expect(await only("hqAdmin", { filter: { to: "2026-11-05" } })).toEqual([ongoing, today, later]);
  });

  it("clamps a From before 2011 to 2011-01-01", async () => {
    await act("2010-06-01");
    const kept = await act("2011-02-01");
    expect(await only("hqAdmin", { filter: { from: "1990-01-01", to: "2011-12-31" } })).toEqual([kept]);
  });

  it("This day only lists activities that start and end that day", async () => {
    const one = await act("2032-03-10");
    await act("2032-03-10", { end: "2032-03-11" });
    await act("2032-03-09", { end: "2032-03-10" });
    expect(await only("hqAdmin", { filter: { from: "2032-03-10", thisDayOnly: true } })).toEqual([one]);
  });

  it("quick search finds a word in any of the eleven fields legacy searched, whatever its case", async () => {
    // No term is part of another, so each search can only find its own activity.
    const cases: [string, Partial<typeof activities.$inferInsert>][] = [
      ["apricotx", { title: "Sample apricotx title" }],
      ["bananax", { details: "Sample bananax details" }],
      ["cherryx", { cityId: w.city.other, otherCity: "Cherryx Bay" }],
      ["damsonx", { translations: ["Damsonx"] }],
      ["elderx", { significance: "Sample elderx" }],
      ["figx", { comments: "Sample figx" }],
      ["guavax", { leadOrganization: "Guavax Society" }],
      ["hucklex", { strategy: "Sample hucklex" }],
      ["jujubex", { schedule: "Sample jujubex" }],
      ["kiwix", { venue: "Kiwix Hall" }],
    ];
    for (const [term, row] of cases) {
      const id = await act("2033-02-01", { row });
      expect(await only("hqAdmin", { filter: { ...year(2033), quickSearch: term.toUpperCase() } }), term).toEqual([id]);
    }
    await tdb.db.insert(cities).values({ id: 900, name: "Sample Lemonx" });
    const c = await act("2033-02-02", { row: { cityId: 900 } });
    expect(await only("hqAdmin", { filter: { ...year(2033), quickSearch: "lemonx" } })).toEqual([c]);
  });

  it("the Executive Summary is searched only for those who see the Look Ahead fieldset (C172)", async () => {
    const id = await act("2033-03-01", { row: { hqComments: "Sample mangox summary" } });
    expect(await only("hqEditor", { filter: { ...year(2033), quickSearch: "mangox" } })).toEqual([id]);
    expect(await only("editor", { filter: { ...year(2033), quickSearch: "mangox" } })).toEqual([]);
    expect(await only("hqReadOnly", { filter: { ...year(2033), quickSearch: "mangox" } })).toEqual([]);
  });

  it("with ShowHqCommentsField on, the Executive Summary is searched only where the user sees it: activities they can edit", async () => {
    const shown = { ...deps, rules: { ...TEST_RULES, showHqCommentsField: true } };
    const own = await act("2033-03-02", { row: { hqComments: "Sample nectarx summary" } });
    // Shared with Health, so a Health editor sees the activity but not its Executive Summary.
    await act("2033-03-02", { row: { contactMinistryKey: "finance", hqComments: "Sample nectarx summary" }, shared: ["health"] });
    const search = async (who: Who) => (await listPageIds(shown, (await loadCalendarActor(tdb.db, w.as[who].id))!, listQuerySchema.parse({ filter: { ...year(2033), quickSearch: "nectarx" } }), 0)).ids;
    expect(await search("editor")).toEqual([own]);
    expect(await search("readOnly")).toEqual([]);
    expect(await search("hqEditor")).toHaveLength(2);
  });

  it("%, _ and \\ in a search are literal characters", async () => {
    const pct = await act("2033-04-01", { row: { title: "Sample 50% off" } });
    await act("2033-04-01", { row: { title: "Sample 500 off" } });
    const under = await act("2033-04-01", { row: { title: "Sample a_b" } });
    await act("2033-04-01", { row: { title: "Sample axb" } });
    const slash = await act("2033-04-01", { row: { title: "Sample c\\d" } });
    const day = { from: "2033-04-01", to: "2033-04-01" };
    expect(await only("hqAdmin", { filter: { ...day, quickSearch: "50%" } })).toEqual([pct]);
    expect(await only("hqAdmin", { filter: { ...day, quickSearch: "a_b" } })).toEqual([under]);
    expect(await only("hqAdmin", { filter: { ...day, quickSearch: "c\\d" } })).toEqual([slash]);
    expect(containsPattern("5%_\\")).toBe("%5\\%\\_\\\\%");
  });

  it("a number above 10,000, or ABBR-number at any size, finds that activity alone, ignoring the other filters and the dates", async () => {
    const big = await act("2020-05-05", { row: { id: 20_001 } });
    const small = await act("2034-01-01", { row: { title: "Sample 2034 report" } });
    expect(await only("hqAdmin", { filter: { quickSearch: "20001", categoryId: w.cat.speech } })).toEqual([big]);
    expect(await only("hqAdmin", { filter: { quickSearch: `HLTH-${small}` } })).toEqual([small]);
    // A bare number up to 10,000 is a word, such as a year.
    expect(await only("hqAdmin", { filter: { ...year(2034), quickSearch: "2034" } })).toEqual([small]);
    expect(idSearchOf("12")).toBeNull();
    expect(idSearchOf("FIN-12")).toBe(12);
    expect(idSearchOf("FIN-0")).toBeNull();
    expect(idSearchOf("99999999999")).toBeNull();
  });

  it("an id search stays inside visibility: another ministry's confidential activity isn't found", async () => {
    const secret = await act("2034-02-01", { row: { id: 20_002, contactMinistryKey: "finance", isConfidential: true } });
    expect(await only("hqEditor", { filter: { quickSearch: "20002" } })).toEqual([]);
    expect(await only("financeEditor", { filter: { quickSearch: "20002" } })).toEqual([secret]);
  });

  it("no filter or display widens visibility: watching, Lead Ministry, Comm Contact and an id search stay inside it", async () => {
    const y = year(2044);
    const elsewhere = await act("2044-01-10", { row: { contactMinistryKey: "finance", commContactId: w.contact.financeEditor } });
    const secret = await act("2044-01-11", { row: { contactMinistryKey: "finance", isConfidential: true } });
    await tdb.db.insert(favourites).values([{ userId: w.as.editor.id, activityId: elsewhere }, { userId: w.as.hqEditor.id, activityId: secret }]);
    const q = (who: Who, filter: object, display: ListQueryInput["display"] = "all") => only(who, { filter: { ...y, ...filter }, display });
    expect(await q("editor", {}, "my_watchlist")).toEqual([]);
    expect(await q("editor", { ministryKey: "finance" })).toEqual([]);
    expect(await q("editor", { ministryKey: "finance" }, "my_ministries")).toEqual([]);
    expect(await q("editor", { commContactUserId: w.as.financeEditor.id })).toEqual([]);
    expect(await q("editor", { commContactUserId: w.as.financeEditor.id }, "my_activities")).toEqual([]);
    expect(await only("editor", { filter: { quickSearch: `FIN-${elsewhere}` } })).toEqual([]);
    expect(await q("hqEditor", {}, "my_watchlist")).toEqual([]);
    expect(await q("hqEditor", { ministryKey: "finance" })).toEqual([elsewhere]);
    expect(await only("hqEditor", { filter: { quickSearch: `FIN-${secret}` } })).toEqual([]);
    expect(await q("financeEditor", { ministryKey: "finance" })).toEqual([elsewhere, secret]);
  });

  it("each filter narrows as legacy's did", async () => {
    const y = year(2035);
    await act("2035-01-10");
    const kw1 = await act("2035-01-11", { keywords: [w.ids.keptKeyword] });
    const kw2 = await act("2035-01-12", { keywords: [w.ids.sampleTag] });
    const issue = await act("2035-01-13", { row: { isIssue: true } });
    const unconfirmedMultiDay = await act("2035-01-14", { end: "2035-01-15", row: { isConfirmed: false } });
    await act("2035-01-16", { row: { isConfirmed: false } });
    const unconfirmedAllDay = await act("2035-01-17", { row: { isConfirmed: false, isAllDay: true } });
    const changed = await act("2035-01-18", { row: { status: "changed" } });
    const event = await act("2035-01-19", { cats: [w.cat.event] });
    const rep = await act("2035-01-20", { row: { governmentRepresentativeId: w.ids.representative } });
    const premier = await act("2035-01-21", { row: { premierRequestedId: w.ids.premierYes } });
    const dist = await act("2035-01-22", { row: { nrDistributionId: w.ids.distribution } });
    const init = await act("2035-01-23", { initiatives: [w.ids.initiative] });
    const q = (filter: object) => only("hqAdmin", { filter: { ...y, ...filter } });
    const all = await q({});
    expect(all).toHaveLength(13);
    expect(await q({ keywordIds: [w.ids.keptKeyword, w.ids.sampleTag] })).toEqual([kw1, kw2]);
    expect(await q({ isIssue: true })).toEqual([issue]);
    // Legacy always counts a timed single-day activity as matching Date Confirmed (ActivityDAO.cs:198).
    expect(await q({ dateConfirmed: true })).toEqual(all.filter((id) => id !== unconfirmedMultiDay && id !== unconfirmedAllDay));
    expect(await q({ status: "changed" })).toEqual([changed]);
    expect(await q({ categoryId: w.cat.event })).toEqual([event]);
    expect(await q({ representativeId: w.ids.representative })).toEqual([rep]);
    expect(await q({ premierRequestedId: w.ids.premierYes })).toEqual([premier]);
    expect(await q({ distributionId: w.ids.distribution })).toEqual([dist]);
    expect(await q({ initiativeId: w.ids.initiative })).toEqual([init]);
  });

  it("Lead Ministry matches the lead or a shared-with ministry; Comm Contact matches the person, inactive contacts included", async () => {
    const y = year(2036);
    const health = await act("2036-01-10");
    const finance = await act("2036-01-11", { row: { contactMinistryKey: "finance" } });
    const sharedToHealth = await act("2036-01-12", { row: { contactMinistryKey: "finance" }, shared: ["health"] });
    const byEditor = await act("2036-01-13", { row: { commContactId: w.contact.editorHealth } });
    const byRetired = await act("2036-01-14", { row: { commContactId: w.contact.retiredHealth } });
    const q = (filter: object) => only("hqAdmin", { filter: { ...y, ...filter } });
    expect(await q({ ministryKey: "health" })).toEqual([health, sharedToHealth, byEditor, byRetired]);
    expect(await q({ ministryKey: "finance" })).toEqual([finance, sharedToHealth]);
    expect(await q({ commContactUserId: w.as.editor.id })).toEqual([byEditor]);
    expect(await q({ commContactUserId: w.as.advanced.id })).toEqual([byRetired]);
  });

  it("My Ministries leaves out what is only shared; My Activities is mine as comm contact; My Watchlist is what I watch", async () => {
    const y = year(2037);
    const own = await act("2037-01-10", { row: { commContactId: w.contact.editorHealth } });
    const shared = await act("2037-01-11", { row: { contactMinistryKey: "finance" }, shared: ["health"] });
    const other = await act("2037-01-12", { row: { commContactId: w.contact.adminHealth } });
    const awareness = await act("2037-01-13", { cats: [w.cat.awareness] });
    await tdb.db.insert(favourites).values([{ userId: w.as.editor.id, activityId: shared }, { userId: w.as.editor.id, activityId: awareness }]);
    const q = (display: ListQueryInput["display"], filter: object = {}) => only("editor", { filter: { ...y, ...filter }, display });
    expect(await q("all")).toEqual([own, shared, other]);
    expect(await q("my_ministries")).toEqual([own, other]);
    expect(await q("my_activities")).toEqual([own]);
    expect(await q("my_activities", { commContactUserId: w.as.admin.id })).toEqual([other]);
    // The default hides don't apply to what you chose to watch.
    expect(await q("my_watchlist")).toEqual([shared, awareness]);
  });

  it("hides Awareness dates and the consultations ministry unless the filter names them", async () => {
    const y = year(2038);
    const plain = await act("2038-01-10");
    const awareness = await act("2038-01-11", { cats: [w.cat.awareness] });
    const consult = await act("2038-01-12", { row: { contactMinistryKey: "consult" } });
    expect(await only("hqAdmin", { filter: y })).toEqual([plain]);
    expect(await only("hqAdmin", { filter: { ...y, categoryId: w.cat.awareness } })).toEqual([awareness]);
    expect(await only("hqAdmin", { filter: { ...y, ministryKey: "consult" } })).toEqual([consult]);
    // Someone whose only ministry is the consultations ministry sees its activities (ActivityListProvider.ashx.cs:91).
    await projectUser(app, { id: CONSULT_USER, email: "consult@example.test", displayName: "Sample Consultations Editor", isActive: true, calendarRole: "Calendar.Editor", organizationKeys: ["consult"] });
    expect((await idsAs(CONSULT_USER, { filter: y })).ids).toEqual([consult]);
  });

  it("deleted activities: HQ Administrators see those awaiting review, also under Changed; nobody else does", async () => {
    const y = year(2039);
    const live = await act("2039-01-10");
    const awaiting = await act("2039-01-11", { row: { deletedAt: FIXED_NOW, needsReview: ["active"] } });
    await act("2039-01-12", { row: { deletedAt: FIXED_NOW } });
    expect(await only("hqAdmin", { filter: y })).toEqual([live, awaiting]);
    expect(await only("hqAdmin", { filter: { ...y, status: "changed" } })).toEqual([awaiting]);
    expect(await only("hqAdmin", { filter: { ...y, status: "reviewed" } })).toEqual([live]);
    expect(await only("hqAdvanced", { filter: y })).toEqual([live]);
    expect(await only("admin", { filter: y })).toEqual([live]);
  });

  it("corporate queries: HQ Advanced and above only; upcoming by days and status; deletions by Changed or Deleted", async () => {
    for (const who of ["hqEditor", "advanced", "admin"] as const) {
      await expect(ids(who, { corporate: { days: 8, statuses: ["new"] } })).rejects.toBeInstanceOf(ActivityForbiddenError);
    }
    // Today is 2026-11-03 in BC; eight days reach the end of 2026-11-11.
    const fresh = await act("2026-11-06", { row: { status: "new" } });
    const changed = await act("2026-11-08", { row: { status: "changed" } });
    const far = await act("2026-11-20", { row: { status: "new" } });
    const laNew = await act("2026-11-09", { row: { hqStatus: "new" } });
    const awaiting = await act("2026-11-10", { row: { deletedAt: FIXED_NOW, needsReview: ["active"] } });
    const done = await act("2026-11-11", { row: { deletedAt: FIXED_NOW } });
    const c = (who: Who, statuses: ("new" | "changed" | "reviewed" | "deleted" | "la_new" | "la_changed")[], days: number | null = 8) => only(who, { corporate: { days, statuses } });
    expect(await c("hqAdvanced", ["new", "changed"])).toEqual([fresh, changed]);
    expect(await c("hqAdmin", ["new", "changed"])).toEqual([fresh, changed, awaiting]);
    expect(await c("hqAdmin", ["deleted"])).toEqual([awaiting, done]);
    expect(await c("hqAdmin", ["la_new"])).toEqual([laNew]);
    expect(await c("hqAdvanced", ["new"], null)).toEqual([fresh, far]);
  });

  it("the Look Ahead filter: HQ Advanced and above only; Look Ahead only drops Not for Look Ahead items, and the reverse", async () => {
    const y = year(2040);
    const open = await act("2040-01-10");
    const secret = await act("2040-01-11", { row: { isConfidential: true } });
    await expect(ids("hqEditor", { filter: y, lookAhead: "look_ahead_only" })).rejects.toBeInstanceOf(ActivityForbiddenError);
    expect(await only("hqAdvanced", { filter: y, lookAhead: "look_ahead_only" })).toEqual([open]);
    expect(await only("hqAdvanced", { filter: y, lookAhead: "not_for_look_ahead_only" })).toEqual([secret]);
    // Visibility still decides: an HQ Editor doesn't see another ministry's confidential item.
    expect(await only("hqEditor", { filter: y })).toEqual([open]);
  });

  it("sorts by each column, then by start and id; empty values last", async () => {
    const y = year(2041);
    const b = await act("2041-01-10", {
      cats: [w.cat.speech],
      row: { title: "Sample Bravo", leadOrganization: "Zed Org", commContactId: w.contact.adminHealth, governmentRepresentativeId: w.ids.representative2 },
    });
    const a = await act("2041-01-11", {
      cats: [w.cat.event],
      row: { title: "sample alpha", leadOrganization: "Alpha Org", commContactId: w.contact.editorHealth, governmentRepresentativeId: w.ids.representative, cityId: w.city.other, otherCity: "Aardvark Cove" },
    });
    const c = await act("2041-01-12", { cats: [w.cat.plain], row: { title: "Sample Charlie", cityId: w.city.sample } });
    const s = (sort: ListQueryInput["sort"], dir: "asc" | "desc" = "asc") => only("hqAdmin", { filter: y, sort, dir });
    expect(await s("title")).toEqual([a, b, c]);
    expect(await s("title", "desc")).toEqual([c, b, a]);
    expect(await s("dateTime", "desc")).toEqual([c, a, b]);
    expect(await s("leadOrg")).toEqual([a, b, c]);
    expect(await s("leadOrg", "desc")).toEqual([b, a, c]);
    // Robin Staff, then Sample Admin; c has no comm contact.
    expect(await s("commContact")).toEqual([a, b, c]);
    expect(await s("governmentRep")).toEqual([a, b, c]);
    // Other City "Aardvark Cove", then "Sample City"; b has no city.
    expect(await s("city")).toEqual([a, c, b]);
    // "Sample approved event", "Sample plain category", "Sample speech".
    expect(await s("categories")).toEqual([a, c, b]);
  });

  it("pages 30 at a time with the total; an offset past the end gives no rows and the true total", async () => {
    const y = year(2042);
    const made: number[] = [];
    for (let n = 0; n < 65; n++) made.push(await act("2042-01-10"));
    expect(await ids("hqAdmin", { filter: y })).toEqual({ ids: made.slice(0, 30), total: 65 });
    expect(await ids("hqAdmin", { filter: y }, 60)).toEqual({ ids: made.slice(60), total: 65 });
    expect(await ids("hqAdmin", { filter: y }, 90)).toEqual({ ids: [], total: 65 });
    expect(await ids("hqAdmin", { filter: year(2043) })).toEqual({ ids: [], total: 0 });
  });
});

describe("the Executive Summary search predicate agrees with can.seeLookAheadFieldset (C172)", () => {
  let tdb: TestDatabase;
  let w: World;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    w = await seedWorld(createTestApp(tdb.db), tdb.db);
  });
  afterAll(() => tdb.drop());

  it("for every role, both tenant settings, and every kind of row", async () => {
    const rows: (VisibilityFacts & { id: number })[] = [];
    for (const contactMinistryKey of ["health", "finance", null])
      for (const sharedMinistryKeys of [[], ["health"], ["finance"]])
        for (const isConfidential of [false, true])
          for (const isDeleted of [false, true]) {
            const id = await insertRaw(tdb.db, { contactMinistryKey, isConfidential, deletedAt: isDeleted ? FIXED_NOW : null });
            for (const m of sharedMinistryKeys) await tdb.db.insert(activitySharedWith).values({ activityId: id, ministryKey: m });
            rows.push({ id, contactMinistryKey, sharedMinistryKeys, isConfidential, isDeleted });
          }
    const all = rows.map((r) => r.id);
    let compared = 0;
    for (const who of Object.keys(w.as) as Who[]) {
      const actor = (await loadCalendarActor(tdb.db, w.as[who].id))!;
      for (const showHqCommentsField of [true, false]) {
        const rules = { ...TEST_RULES, showHqCommentsField };
        const shown = executiveSummaryShown({ actor, rules, today: "2026-11-03", consultationsKeys: [] });
        const got = await tdb.db
          .select({ id: activities.id })
          .from(activities)
          .where(and(visibleSql(actor), inArray(activities.id, all), shown ?? sql`false`))
          .orderBy(asc(activities.id));
        const expected = rows.filter((r) => visible(actor, r) && can.seeLookAheadFieldset(actor, rules, r)).map((r) => r.id);
        expect(got.map((r) => r.id), `${who}, showHqCommentsField ${showHqCommentsField}`).toEqual(expected);
        compared++;
      }
    }
    expect(compared).toBe(Object.keys(w.as).length * 2);
  });
});
