import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { listQuerySchema, type ListQueryInput } from "@gcpe/calendar-contract";
import { loadCalendarActor } from "../actor";
import { createCalendarTestDb, createTestApp, FIXED_NOW, TEST_RULES } from "../../test/helpers";
import { insertRaw, seedWorld, type Who, type World } from "../../test/world";
import { bc, outline, plain, reportRow } from "../../test/report-rows";
import { reportData, ReportTooLargeError, type ReportRow } from "./data";
import { LOOK_AHEAD_MAX_DAYS, lookAheadDoc, lookAheadRange, type LookAheadContext } from "./look-ahead";
import type { TableBlock } from "./model";
import { COLOURS } from "./text";

const tz = TEST_RULES.timeZone;
// 2026-11-03 11:00 BC. 2026-11-13 is a Friday.
const NOW = new Date("2026-11-03T18:00:00Z");
const q = (i: ListQueryInput) => listQuerySchema.parse(i);
const ctx = (rows: ReportRow[], over: Partial<LookAheadContext> = {}): LookAheadContext => ({
  rules: TEST_RULES, isHq: false, now: NOW, today: "2026-11-03", origin: "https://staff.example.test", consultationsKeys: ["consult"], rows,
  q: q({ filter: { from: "2026-11-10", to: "2026-11-12" } }), ...over,
});
const at = (day: string, time: string) => bc(day, time);
const row = (id: number, over: Partial<ReportRow>) => reportRow({ id, title: `Sample ${id}`, ...over });
const tables = (blocks: ReturnType<typeof lookAheadDoc>["blocks"]) => blocks.filter((b): b is TableBlock => b.kind === "table");

// Every case on 2026-11-10..12 (Tue to Thu), in legacy's order (start date, end date, start time).
const B = row(20002, { hqSection: "events_and_speeches", isAllDay: true, startAt: at("2026-11-10", "00:00"), endAt: at("2026-11-12", "23:59") });
const E = row(20005, { hqSection: "in_the_news", startAt: at("2026-11-10", "09:00"), endAt: at("2026-11-11", "17:00") });
const F = row(20006, { hqSection: "in_the_news", isConfirmed: false, startAt: at("2026-11-10", "10:00"), endAt: at("2026-11-16", "10:00") });
const C = row(20003, { hqSection: "events_and_speeches", isConfirmed: false, startAt: at("2026-11-10", "08:00"), endAt: at("2026-11-10", "18:00") });
const A = row(20001, { hqSection: "events_and_speeches", startAt: at("2026-11-10", "09:00"), endAt: at("2026-11-10", "10:00"), hqStatus: "new" });
const G = row(20007, { hqSection: "not_on_la", categoryIds: [2], isAllDay: true, startAt: at("2026-11-10", "00:00"), endAt: at("2026-11-10", "23:59") });
const H = row(20008, { hqSection: "not_on_la", ministryKey: "consult", ministryAbbreviation: "CONSULT", startAt: at("2026-11-10", "11:00"), endAt: at("2026-11-10", "12:00") });
const I = row(20009, { hqSection: "not_on_la", isConfidential: true, startAt: at("2026-11-10", "12:00"), endAt: at("2026-11-10", "13:00") });
const J = row(20010, { hqSection: "issues_and_reports", isIssue: true, startAt: at("2026-11-10", "13:00"), endAt: at("2026-11-10", "14:00") });
const D = row(20004, { hqSection: "in_the_news", startAt: at("2026-11-11", "09:00"), endAt: at("2026-11-11", "10:00") });
const ROWS = [B, E, F, C, A, G, H, I, J, D];

describe("the Look Ahead's range and title (ActivityHandler.ashx.cs:640-673)", () => {
  it("no To: 60 days from From or today, and the Long Term Outlook; the Exec, one month", () => {
    expect(lookAheadRange(q({}), "2026-11-03", tz, false)).toMatchObject({ from: "2026-11-03", to: "2027-01-01", includeOutlook: true });
    expect(lookAheadRange(q({}), "2026-11-03", tz, false).outlookAfter).toEqual(new Date(bc("2027-01-02", "00:00")));
    expect(lookAheadRange(q({ filter: { from: "2026-01-31" } }), "2026-11-03", tz, true)).toMatchObject({ from: "2026-01-31", to: "2026-02-28", includeOutlook: true });
  });
  it("a To: those days, no Outlook; This day only: one day", () => {
    expect(lookAheadRange(q({ filter: { from: "2026-11-10", to: "2026-11-12" } }), "2026-11-03", tz, false)).toEqual({ from: "2026-11-10", to: "2026-11-12", includeOutlook: false, outlookAfter: null });
    expect(lookAheadRange(q({ filter: { from: "2026-11-10", thisDayOnly: true } }), "2026-11-03", tz, false)).toMatchObject({ from: "2026-11-10", to: "2026-11-10", includeOutlook: false });
  });
  it("legacy's title: the start's year only when both ends share it", () => {
    const title = (i: ListQueryInput) => plain((lookAheadDoc(ctx([], { q: q(i) }), { detailed: false }).blocks[1] as { runs: { text: string }[] }).runs);
    expect(title({ filter: { from: "2026-11-10", to: "2026-11-12" } })).toBe("Tuesday, Nov. 10, 2026 to Thursday, Nov. 12, 2026");
    expect(title({ filter: { from: "2026-12-30", to: "2027-01-02" } })).toBe("Wednesday, Dec. 30 to Saturday, Jan. 2, 2027");
    expect(title({ filter: { from: "2026-11-10", thisDayOnly: true } })).toBe("Tuesday, Nov. 10, 2026");
  });
  it(`refuses more than ${LOOK_AHEAD_MAX_DAYS} days`, () => {
    expect(() => lookAheadDoc(ctx([], { q: q({ filter: { from: "2026-01-01", to: "2027-01-02" } }) }), { detailed: false })).toThrow(ReportTooLargeError);
  });
});

describe("the Look Ahead's sections, in legacy's order (spec addendum §10.2)", () => {
  it("for a ministry user: the cover without Consultations, each day's Events, Issues by legacy's ministry rule, each day's In the News, Awareness Dates", () => {
    expect(outline(lookAheadDoc(ctx(ROWS), { detailed: false }))).toEqual([
      "[banner] SAMPLE PROVINCE CORPORATE LOOK AHEAD",
      "# Tuesday, Nov. 10, 2026 to Thursday, Nov. 12, 2026",
      "# Contents:",
      "[legend] Events, Speeches and Releases (Inside Government) | Issues and Reports | In the News (Outside Government) | Awareness Dates",
      "---",
      "# Inside Government",
      // Time-TBD and multi-day rows first, in list order; then the day's timed rows.
      "# Tuesday, November 10, 2026", "# Events, Speeches & Releases", "HLTH-20002", "HLTH-20003", "HLTH-20001",
      "# Wednesday, November 11, 2026", "# Events, Speeches & Releases", "HLTH-20002",
      "# Thursday, November 12, 2026", "# Events, Speeches & Releases", "HLTH-20002",
      "---",
      // A ministry's Issues: not Not for Look Ahead, unconfirmed, five days or more (J's HQ section doesn't count).
      // For a ministry, no break after Issues, before Outside Government or before Awareness (LookAheadReport.rdlc).
      "# ISSUES AND REPORTS", "HLTH-20006",
      "# Outside Government",
      "# In the News", "HLTH-20005",
      "# In the News", "HLTH-20004", "HLTH-20005",
      "# AWARENESS DATES", "HLTH-20007",
    ]);
  });

  it("an empty day says so; an empty Issues or Awareness isn't drawn; the consultations ministry's and a confidential Not on LA activity appear nowhere", () => {
    const doc = lookAheadDoc(ctx([H, I], { q: q({ filter: { from: "2026-11-10", thisDayOnly: true } }) }), { detailed: false });
    expect(outline(doc).filter((l) => !l.startsWith("[") && l !== "# Contents:")).toEqual([
      "# Tuesday, Nov. 10, 2026", "---", "# Inside Government", "# No Activities for Tuesday, November 10, 2026", "---", "# Outside Government",
    ]);
  });

  it("for HQ: Issues by the stored section, HQ's FYI category, and a break after every day but a Saturday", () => {
    const fri = (id: number, day: string) => row(id, { hqSection: "events_and_speeches", startAt: at(day, "09:00"), endAt: at(day, "10:00") });
    const rows = [J, fri(20011, "2026-11-13"), fri(20012, "2026-11-14"), fri(20013, "2026-11-15")];
    const doc = lookAheadDoc(ctx(rows, { isHq: true, q: q({ filter: { from: "2026-11-13", to: "2026-11-15" } }) }), { detailed: false });
    expect(outline(doc).slice(5)).toEqual([
      "# Inside Government",
      "# Friday, November 13, 2026", "# Events, Speeches & Releases", "HLTH-20011", "---",
      "# Saturday, November 14, 2026", "# Events, Speeches & Releases", "HLTH-20012",
      "# Sunday, November 15, 2026", "# Events, Speeches & Releases", "HLTH-20013", "---",
      // Issues and Reports isn't split by day: every row the list's filter brought (ActivityHandler.ashx.cs:920-923).
      // HQ breaks after Issues when it has rows. Nothing follows Outside Government here, so no break before an empty Awareness.
      "# ISSUES AND REPORTS", "HLTH-20010", "---", "# Outside Government",
    ]);
    const hqIssues = lookAheadDoc(ctx(ROWS, { isHq: true }), { detailed: false });
    const issues = tables(hqIssues.blocks).find((t) => plain(t.header[0]!.runs) === "Date")!;
    expect(issues.rows.map((r) => plain(r[1]!.runs))).toEqual(["HLTH-20010"]);
    expect(plain(issues.rows[0]![3]!.runs)).toBe("Issue");
    const news = tables(hqIssues.blocks).filter((t) => plain(t.header[1]!.runs) === "CC ID#" && plain(t.header[0]!.runs) !== "Date");
    // F (unconfirmed, six days) is HQ's In the News on each of its days, an FYI.
    expect(news.map((t) => t.rows.map((r) => `${plain(r[1]!.runs)} ${plain(r[3]!.runs)}`))).toEqual([
      ["HLTH-20005 FYI", "HLTH-20006 FYI"], ["HLTH-20004 FYI", "HLTH-20005 FYI", "HLTH-20006 FYI"], ["HLTH-20006 FYI"],
    ]);
  });

  it("no To: the Long Term Outlook after 60 days, HQ seeing only those marked for it", () => {
    const later = row(20020, { hqSection: "events_and_speeches", startAt: at("2027-01-20", "09:00"), endAt: at("2027-01-20", "10:00") });
    const marked = row(20021, { hqSection: "events_and_speeches", longTermOutlook: true, startAt: at("2027-01-21", "09:00"), endAt: at("2027-01-21", "10:00") });
    const tail = (isHq: boolean) => outline(lookAheadDoc(ctx([later, marked], { isHq, q: q({}) }), { detailed: false })).slice(-3);
    expect(tail(false)).toEqual(["# LONG TERM OUTLOOK", "HLTH-20020", "HLTH-20021"]);
    expect(tail(true)).toEqual(["---", "# LONG TERM OUTLOOK", "HLTH-20021"]);
    const legend = lookAheadDoc(ctx([], { q: q({}) }), { detailed: false }).blocks[3];
    expect(legend).toMatchObject({ kind: "legend", items: [{}, {}, {}, {}, { colour: COLOURS.outlook }] });
  });
});

describe("the lower sections' page breaks (LookAheadReport.rdlc)", () => {
  const aware = row(20050, { hqSection: "not_on_la", categoryIds: [2], startAt: at("2026-11-10", "09:00"), endAt: at("2026-11-10", "10:00") });
  const later = row(20051, { hqSection: "events_and_speeches", longTermOutlook: true, startAt: at("2027-01-20", "09:00"), endAt: at("2027-01-20", "10:00") });
  const issue = row(20052, { hqSection: "issues_and_reports", startAt: at("2026-11-10", "13:00"), endAt: at("2026-11-10", "14:00") });
  const end = (rows: ReportRow[], isHq: boolean, n: number, filter: ListQueryInput["filter"] = { from: "2026-11-10", to: "2026-11-12" }) =>
    outline(lookAheadDoc(ctx(rows, { isHq, q: q({ filter }) }), { detailed: false })).slice(-n);
  it("Issues: HQ breaks after it only when it has rows; a ministry never does; an empty one isn't drawn", () => {
    expect(end([issue], true, 4)).toEqual(["# ISSUES AND REPORTS", "HLTH-20052", "---", "# Outside Government"]);
    expect(end([], true, 3)).toEqual(["# No Activities for Thursday, November 12, 2026", "---", "# Outside Government"]);
    expect(end([F], false, 3)).toEqual(["# ISSUES AND REPORTS", "HLTH-20006", "# Outside Government"]);
  });
  it("Awareness: HQ breaks before it, a ministry doesn't", () => {
    expect(end([aware], true, 4)).toEqual(["# Outside Government", "---", "# AWARENESS DATES", "HLTH-20050"]);
    expect(end([aware], false, 3)).toEqual(["# Outside Government", "# AWARENESS DATES", "HLTH-20050"]);
  });
  it("with the Outlook: a break between Awareness and the Outlook; an empty Outlook isn't drawn", () => {
    const noTo = { from: "2026-11-10" };
    expect(end([aware, later], false, 6, noTo)).toEqual(["# Outside Government", "# AWARENESS DATES", "HLTH-20050", "---", "# LONG TERM OUTLOOK", "HLTH-20051"]);
    expect(end([aware, later], true, 7, noTo)).toEqual(["# Outside Government", "---", "# AWARENESS DATES", "HLTH-20050", "---", "# LONG TERM OUTLOOK", "HLTH-20051"]);
    // HQ sees only the rows marked for the Outlook: none here, so no heading and no break after Awareness.
    expect(end([aware, { ...later, longTermOutlook: false }], true, 4, noTo)).toEqual(["# Outside Government", "---", "# AWARENESS DATES", "HLTH-20050"]);
  });
  it("HQ's Saturday: legacy counts the day's rows twice, so 7 rows (2 x 9 > 16) break and 6 (2 x 8) don't (ActivityHandler.ashx.cs:719-721)", () => {
    const sat = (n: number) => Array.from({ length: n }, (_, i) => row(20060 + i, { hqSection: "events_and_speeches", startAt: at("2026-11-14", "09:00"), endAt: at("2026-11-14", "10:00") }));
    const afterSaturday = (n: number) => {
      const lines = outline(lookAheadDoc(ctx(sat(n), { isHq: true, q: q({ filter: { from: "2026-11-14", to: "2026-11-15" } }) }), { detailed: false }));
      return lines[lines.indexOf("# No Activities for Sunday, November 15, 2026") - 1];
    };
    expect(afterSaturday(7)).toBe("---");
    expect(afterSaturday(6)).toBe("HLTH-20065");
  });
});

describe("a ministry's Issues span (ActivityHandler.ashx.cs:923-929)", () => {
  it("counts BC wall-clock days, as legacy's (End - Start).Days: Mar 5 09:00 to Mar 10 09:00 across spring forward is five", () => {
    const r = row(20070, { hqSection: "in_the_news", isConfirmed: false, startAt: new Date("2026-03-05T17:00:00Z").toISOString(), endAt: new Date("2026-03-10T16:00:00Z").toISOString() });
    const doc = lookAheadDoc(ctx([r], { q: q({ filter: { from: "2026-03-05", to: "2026-03-10" } }) }), { detailed: false });
    expect(outline(doc).slice(-3)).toEqual(["# ISSUES AND REPORTS", "HLTH-20070", "# Outside Government"]);
  });
});

describe("a Look Ahead row (ActivityHandler.ashx.cs:984-1061)", () => {
  const day = (doc: ReturnType<typeof lookAheadDoc>, n = 0) => tables(doc.blocks)[n]!;
  it("date without the day it sits under, the flag on its start day only, lead, text, RLS and the linked CC ID#", () => {
    const doc = lookAheadDoc(ctx([B, A]), { detailed: false });
    const [first, second] = day(doc).rows;
    expect(plain(day(doc).header[0]!.runs)).toBe("Tue Nov 10");
    expect(plain(first![0]!.runs)).toBe("Nov 10-12");
    expect(plain(second![0]!.runs)).toBe("9:00 AM\nNEW");
    expect(second!.map((cell) => plain(cell.runs))).toEqual(["9:00 AM\nNEW", "HLTH", "Sample City - Sample 20001: Sample details", "-", "HLTH-20001"]);
    expect(second![4]!.runs[0]!.link).toBe("https://staff.example.test/hub/calendar/activities/20001");
    expect([first![2]!.fill, second![2]!.fill]).toEqual([COLOURS.zebra, undefined]);
    expect(first![0]!.fill).toBe(COLOURS.events);
    // The flag doesn't repeat on a later day of a multi-day row.
    const multi = lookAheadDoc(ctx([{ ...B, hqStatus: "changed" }]), { detailed: false });
    expect(tables(multi.blocks).slice(0, 3).map((t) => plain(t.rows[0]![0]!.runs))).toEqual(["Nov 10-12\nCHANGED", "Nov 10-12", "Nov 10-12"]);
  });

  it("Time TBD and TBC are bold blue after the date", () => {
    const cell = day(lookAheadDoc(ctx([C]), { detailed: false })).rows[0]![0]!;
    expect(cell.runs).toEqual([{ text: "", color: COLOURS.white }, { text: "Time TBD", bold: true, color: COLOURS.pending }]);
  });

  it("the Executive Summary in place of the title and details, where the row carries it", () => {
    const doc = lookAheadDoc(ctx([{ ...A, executiveSummary: "**Sample summary** for HQ" }], { isHq: true }), { detailed: false });
    expect(plain(day(doc).rows[0]![2]!.runs)).toBe("Sample summary for HQ");
  });

  it("the Exec Look Ahead: the detailed text, and issues highlighted in every table", () => {
    const doc = lookAheadDoc(ctx([{ ...A, isIssue: true, lastUpdatedAt: "2026-11-03T16:15:00Z" }], { isHq: true }), { detailed: true });
    const r = day(doc).rows[0]!;
    expect(plain(r[2]!.runs)).toBe("Sample 20001\nSample details\nSample significance\nSample City  Last updated today at 9:15 AM");
    expect(r[2]!.fill).toBe(COLOURS.issues);
    expect(doc.title).toBe("Exec Look Ahead");
  });

  it("the running text: page 1 only the DRAFT ONLY line; later pages the province, DRAFT AND CONFIDENTIAL, Updated, the CHANGED note and Page X of Y", () => {
    const doc = lookAheadDoc(ctx([]), { detailed: false });
    expect(doc.firstPage).toEqual({ header: { right: [{ text: "DRAFT ONLY - NOT FOR CIRCULATION\nInformation is confidential and subject to change" }] }, footer: null });
    expect(plain(doc.header!.left!)).toBe("Sample Province");
    expect(plain(doc.header!.right!)).toBe("DRAFT AND CONFIDENTIAL");
    expect(plain(doc.footer!.left!)).toBe("Updated Tuesday, Nov 3, 2026 11:00 AM");
    expect(doc.footer).toMatchObject({ pageNumbers: true });
    expect(doc.page).toBe("letter-portrait");
  });
});

// Seeded into every field a Look Ahead row never prints; none may reach the document.
const NEVER_PRINTED: Partial<ReportRow> = {
  strategy: "MARK-strategy", schedule: "MARK-schedule", keywords: ["MARK-keyword"], watcherNames: ["MARK-watcher"], lastUpdatedByName: "MARK-updater",
  leadOrganization: "MARK-lead", translations: ["MARK-translation"], commContact: { name: "MARK-contact", phone: "MARK-phone" },
  governmentRepresentative: "MARK-representative", eventPlanner: "MARK-planner", nrDistribution: "MARK-distribution", premierRequested: "MARK-premier",
  potentialDates: "MARK-potential", needsReview: ["active"],
};
const SECTION_VALUES = ["events_and_speeches", "issues_and_reports", "in_the_news", "not_on_la"];
const cellTexts = (doc: ReturnType<typeof lookAheadDoc>) => tables(doc.blocks).flatMap((t) => t.rows.flatMap((r) => r.map((cell) => plain(cell.runs))));

describe("what a Look Ahead row never prints", () => {
  // One row in every table: a day's Events, HQ's Issues, a day's In the News, Awareness Dates and the Long Term Outlook.
  const placed = [
    row(20030, { ...NEVER_PRINTED, hqSection: "events_and_speeches", hqStatus: "new" }),
    row(20031, { ...NEVER_PRINTED, hqSection: "issues_and_reports" }),
    row(20032, { ...NEVER_PRINTED, hqSection: "in_the_news" }),
    row(20033, { ...NEVER_PRINTED, hqSection: "not_on_la", categoryIds: [2] }),
    row(20034, { ...NEVER_PRINTED, hqSection: "events_and_speeches", longTermOutlook: true, startAt: at("2027-03-01", "09:00"), endAt: at("2027-03-01", "10:00") }),
  ];
  for (const detailed of [false, true]) {
    for (const isHq of [false, true]) {
      it(`${detailed ? "Exec " : ""}Look Ahead, ${isHq ? "HQ" : "a ministry"}: none of the list row's other fields, and the section and Long Term Outlook only place the row`, () => {
        // The Exec prints the venue (City: Venue); the Look Ahead never does.
        const rows = placed.map((r) => ({ ...r, ...(detailed ? {} : { venue: "MARK-venue" }) }));
        const doc = lookAheadDoc(ctx(rows, { isHq, q: q({ filter: { from: "2026-11-10" } }) }), { detailed });
        expect(cellTexts(doc).some((t) => t.includes("HLTH-20030"))).toBe(true);
        expect(cellTexts(doc).some((t) => t.includes(isHq ? "HLTH-20031" : "HLTH-20034"))).toBe(true);
        const json = JSON.stringify(doc);
        expect(json).not.toContain("MARK-");
        for (const v of SECTION_VALUES) expect(json).not.toContain(v);
        expect(cellTexts(doc).filter((t) => /long term outlook|true|false/i.test(t))).toEqual([]);
      });
    }
  }
});

describe("a Look Ahead row with no start date", () => {
  it("builds for every viewer and both reports, with or without an end; it shows its potential dates where it lands", () => {
    // Legacy had none (0 of 83,607, survey 4.5) and saving requires both dates; an imported one must still not crash.
    // The list's date filter reads an activity with an end but no start (coalesce(start_at, end_at)).
    const undated = (id: number, over: Partial<ReportRow>) => row(id, { startAt: null, endAt: id % 2 ? at("2026-11-11", "10:00") : null, isConfirmed: false, potentialDates: "Sample spring", ...over });
    const rows = [
      undated(20040, { hqSection: "events_and_speeches" }),
      undated(20041, { hqSection: "issues_and_reports" }),
      undated(20042, { hqSection: "in_the_news" }),
      undated(20043, { hqSection: "not_on_la", categoryIds: [2] }),
      undated(20044, { hqSection: "events_and_speeches", longTermOutlook: true }),
    ];
    for (const detailed of [false, true]) {
      for (const isHq of [false, true]) {
        for (const filter of [{ from: "2026-11-10" }, { from: "2026-11-10", to: "2026-11-12" }]) {
          expect(() => lookAheadDoc(ctx(rows, { isHq, q: q({ filter }) }), { detailed })).not.toThrow();
        }
      }
    }
    const hq = lookAheadDoc(ctx(rows, { isHq: true, q: q({ filter: { from: "2026-11-10" } }) }), { detailed: false });
    const issues = tables(hq.blocks).find((t) => plain(t.header[0]!.runs) === "Date" && plain(t.header[1]!.runs) === "CC ID#")!;
    expect(issues.rows.map((r) => plain(r[0]!.runs))).toEqual(["Sample spring"]);
  });
});

describe("the Look Ahead fields at the built document (spec addendum §6)", () => {
  let tdb: TestDatabase;
  let w: World;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    w = await seedWorld(createTestApp(tdb.db), tdb.db);
    const base = { hqComments: "**MARK-summary** for HQ", hqStatus: "new" as const, strategy: "MARK-strategy", schedule: "MARK-schedule", leadOrganization: "MARK-lead", translations: ["MARK-translation"] };
    for (const [hqSection, day] of [["events_and_speeches", "2046-03-10"], ["issues_and_reports", "2046-03-10"], ["in_the_news", "2046-03-11"]] as const) {
      await insertRaw(tdb.db, { ...base, title: `Sample ${hqSection}`, hqSection, startAt: new Date(`${day}T17:00:00Z`), endAt: new Date(`${day}T18:00:00Z`) });
    }
    await insertRaw(tdb.db, { ...base, title: "Sample changed", hqStatus: "changed", hqSection: "events_and_speeches", startAt: new Date("2046-03-12T17:00:00Z"), endAt: new Date("2046-03-12T18:00:00Z") });
    await insertRaw(tdb.db, { ...base, title: "Sample undated", hqSection: "issues_and_reports", startAt: null, endAt: new Date("2046-03-11T18:00:00Z"), isConfirmed: false, potentialDates: "Sample spring" });
  });
  afterAll(() => tdb.drop());

  const docOf = async (who: Who, detailed: boolean, showHqCommentsField = false) => {
    const rules = { ...TEST_RULES, showHqCommentsField };
    const actor = (await loadCalendarActor(tdb.db, w.as[who].id))!;
    const deps = { db: tdb.db, rules, subscribers: [], now: () => FIXED_NOW };
    const d = await reportData(deps, actor, q({ filter: { from: "2046-03-10", to: "2046-03-12" } }));
    expect(d.rows).toHaveLength(5);
    return lookAheadDoc({ rules, isHq: actor.isHq, now: d.now, today: "2026-11-03", origin: null, consultationsKeys: ["consult"], rows: d.rows, q: d.q }, { detailed });
  };
  const flags = (doc: ReturnType<typeof lookAheadDoc>) => tables(doc.blocks).flatMap((t) => t.rows.flatMap((r) => r.flatMap((cell) => cell.runs))).filter((r) => r.color === COLOURS.flag).map((r) => r.text.trim());

  // Every role that doesn't see the Look Ahead fieldset on these Health activities; with ShowHqCommentsField on,
  // a Health Editor and above does (spec addendum §6).
  const HIDDEN: [Who, boolean][] = [
    ["readOnly", false], ["editor", false], ["advanced", false], ["admin", false], ["hqReadOnly", false],
    ["readOnly", true], ["hqReadOnly", true],
  ];
  for (const [who, show] of HIDDEN) {
    for (const detailed of [false, true]) {
      it(`${who}${show ? " (ShowHqCommentsField on)" : ""}, ${detailed ? "Exec Look Ahead" : "Look Ahead"}: no Executive Summary, no NEW or CHANGED, no other list field`, async () => {
        const doc = await docOf(who, detailed, show);
        expect(JSON.stringify(doc)).not.toContain("MARK-");
        expect(flags(doc)).toEqual([]);
        expect(cellTexts(doc).filter((t) => /\n(NEW|CHANGED)\b/.test(t))).toEqual([]);
      });
    }
  }

  const SEES: [Who, boolean][] = [["hqAdmin", false], ["editor", true], ["advanced", true], ["admin", true]];
  for (const [who, show] of SEES) {
    it(`${who}${show ? " (ShowHqCommentsField on)" : ""}, who sees the fieldset: the same checks find the summary and the flags, never the other fields`, async () => {
      const doc = await docOf(who, false, show);
      expect(JSON.stringify(doc)).toContain("MARK-summary");
      // A ministry's Look Ahead places neither issues_and_reports row (the five-day rule), so two fewer flags.
      expect(flags(doc).sort()).toEqual(who === "hqAdmin" ? ["CHANGED", "NEW", "NEW", "NEW", "NEW"] : ["CHANGED", "NEW", "NEW"]);
      expect(JSON.stringify(doc)).not.toMatch(/MARK-(strategy|schedule|lead|translation)/);
    });
  }
});
