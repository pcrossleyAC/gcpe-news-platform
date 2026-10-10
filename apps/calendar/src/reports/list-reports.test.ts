import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { listQuerySchema, REPORT_KINDS, type ListQueryInput, type ReportKind } from "@gcpe/calendar-contract";
import { loadCalendarActor } from "../actor";
import { createCalendarTestDb, createTestApp, FIXED_NOW, projectUser, TEST_RULES } from "../../test/helpers";
import { insertRaw, seedWorld, type Who, type World } from "../../test/world";
import { bc, outline, plain, reportRow } from "../../test/report-rows";
import { buildReport } from "./build";
import { reportData, ReportTooLargeError, type ReportRow } from "./data";
import type { ReportDoc, TableBlock } from "./model";
import { planningDoc, planningTags } from "./planning";
import { COLOURS } from "./text";
import { thirtySixtyNinetyDoc, thirtySixtyNinetyMonths, type ListReportContext } from "./thirty-sixty-ninety";

const NOW = new Date("2026-11-03T18:00:00Z");
const q = (i: ListQueryInput) => listQuerySchema.parse(i);
const ctx = (rows: ReportRow[], i: ListQueryInput = {}): ListReportContext => ({ rules: TEST_RULES, isHq: false, now: NOW, today: "2026-11-03", origin: "https://staff.example.test", rows, q: q(i) });
const on = (id: number, day: string, over: Partial<ReportRow> = {}) => reportRow({ id, title: `Sample ${id}`, startAt: bc(day, "09:00"), endAt: bc(day, "10:00"), ...over });
const tables = (doc: ReportDoc) => doc.blocks.filter((b): b is TableBlock => b.kind === "table");
const cellTexts = (doc: ReportDoc) => tables(doc).flatMap((t) => t.rows.flatMap((r) => r.map((cell) => plain(cell.runs))));

describe("the 30/60/90 report (spec addendum §10.4)", () => {
  it("months: From or today snapped to the 1st, through 90 days on (3 or 4 months), or through To", () => {
    expect(thirtySixtyNinetyMonths(q({}), "2026-11-03")).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]);
    expect(thirtySixtyNinetyMonths(q({ filter: { from: "2026-01-15" } }), "2026-11-03")).toEqual(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"]);
    expect(thirtySixtyNinetyMonths(q({ filter: { from: "2026-11-15", to: "2026-12-02" } }), "2026-11-03")).toEqual(["2026-11-01", "2026-12-01"]);
    expect(thirtySixtyNinetyMonths(q({ filter: { from: "2026-11-15", thisDayOnly: true } }), "2026-11-03")).toEqual(["2026-11-01"]);
  });

  it("refuses more than 366 days from the snapped 1st (13 months), as the Look Ahead; legacy had no cap", () => {
    expect(thirtySixtyNinetyMonths(q({ filter: { from: "2026-11-15", to: "2027-11-01" } }), "2026-11-03")).toHaveLength(13);
    expect(() => thirtySixtyNinetyDoc(ctx([], { filter: { from: "2026-11-15", to: "2027-11-01" } }))).not.toThrow();
    expect(() => thirtySixtyNinetyDoc(ctx([], { filter: { from: "2026-11-15", to: "2027-11-02" } }))).toThrow(new ReportTooLargeError("months in the range"));
    expect(() => thirtySixtyNinetyDoc(ctx([], { filter: { from: "1900-01-01", to: "2199-12-31" } }))).toThrow(ReportTooLargeError);
  });

  it("each activity once, under the month it starts; one that started earlier under the first month; later ones left out", () => {
    const rows = [
      reportRow({ id: 20001, startAt: bc("2026-10-28", "09:00"), endAt: bc("2026-11-04", "10:00") }),
      on(20002, "2026-11-10"),
      reportRow({ id: 20003, startAt: bc("2026-11-30", "09:00"), endAt: bc("2026-12-02", "10:00") }),
      on(20004, "2026-12-01"),
      on(20005, "2027-02-01"),
    ];
    // Main30_60_90Report.rdlc: the ReportDate group breaks the page between months.
    expect(outline(thirtySixtyNinetyDoc(ctx(rows, { filter: { from: "2026-11-03" } })))).toEqual([
      "# 30 / 60 / 90 REPORT",
      "# November 2026", "HLTH-20001", "HLTH-20002", "HLTH-20003",
      "---",
      "# December 2026", "HLTH-20004",
      "---",
      "# January 2027",
    ]);
  });

  it("an empty month keeps its heading but draws no table, as legacy's empty subreport; no break after the last month", () => {
    const doc = thirtySixtyNinetyDoc(ctx([on(20004, "2026-12-01")], { filter: { from: "2026-11-03" } }));
    expect(doc.blocks.map((b) => b.kind)).toEqual(["heading", "heading", "pageBreak", "heading", "table", "pageBreak", "heading"]);
    expect(thirtySixtyNinetyDoc(ctx([], { filter: { from: "2026-11-03", thisDayOnly: true } })).blocks.map((b) => b.kind)).toEqual(["heading", "heading"]);
  });

  it("a row: friendly date, bold title with 9 pt details and Significance, strategy and materials, CC ID# with the contact and when; Issue rows purple", () => {
    const doc = thirtySixtyNinetyDoc(ctx([on(20001, "2026-11-10", { isIssue: true, strategy: "Sample strategy", commMaterials: ["Sample news release"], status: "new", createdAt: "2026-11-02T18:00:00Z" })]));
    const row = (doc.blocks[2] as TableBlock).rows[0]!;
    expect(row.map((c) => plain(c.runs))).toEqual([
      "Tue Nov 10 9:00-10:00 AM",
      "Sample City - Sample 20001: Sample details\nSignificance: Sample significance",
      "Sample strategy\n\nSample news release",
      "HLTH-20001\nRobin Staff\n\ncreated yesterday",
    ]);
    expect(row.slice(1).map((c) => c.fill)).toEqual([COLOURS.issues, COLOURS.issues, COLOURS.issues]);
    expect(row[0]!.fill).toBe(COLOURS.thirtySixtyNinety);
    expect(plain(doc.footer!.left!)).toBe("DRAFT AND CONFIDENTIAL Updated Tuesday, Nov 3, 2026 11:00 AM");
    expect(doc.header).toBeNull();
  });

  it("legacy's measured styling: 18 pt title, navy 16 pt month headings, brown 9 pt footer, 8 pt black created/updated, legacy's widths", () => {
    const doc = thirtySixtyNinetyDoc(ctx([on(20001, "2026-11-10")]));
    expect(doc.blocks[0]).toMatchObject({ kind: "heading", size: 18, runs: [{ text: "30 / 60 / 90 REPORT", bold: true }] });
    expect(doc.blocks[1]).toMatchObject({ kind: "heading", size: 16, runs: [{ text: "November 2026", bold: true, color: "#384c70" }] });
    expect(doc.footer!.left).toEqual([{ text: "DRAFT AND CONFIDENTIAL", color: "#a52a2a", size: 9 }, { text: " Updated Tuesday, Nov 3, 2026 11:00 AM", size: 9 }]);
    const table = tables(doc)[0]!;
    // 57.6 / 338.4 / 122.4 / 57.6 pt: the middle column takes the rest of legacy's 576 pt line.
    expect(table.widths).toEqual([57.6, "*", 122.4, 57.6]);
    expect(table.rows[0]![3]!.runs.at(-1)).toEqual({ text: "\n\nupdated 1 month ago", size: 8 });
  });

  it("with no contact, ID/CONT is the CC ID# alone (GenerateMonthly30_60_90)", () => {
    const doc = thirtySixtyNinetyDoc(ctx([on(20001, "2026-11-10", { commContact: null })]));
    expect(plain(tables(doc)[0]!.rows[0]![3]!.runs)).toBe("HLTH-20001");
  });
});

describe("the Planning report (spec addendum §10.5)", () => {
  it("Legal landscape, its title and Updated stamp, one row per activity in legacy's order", () => {
    const doc = planningDoc(ctx([on(20002, "2026-11-10"), on(20001, "2026-11-11")]));
    expect(doc.page).toBe("legal-landscape");
    expect(plain(doc.header!.left!)).toBe("Sample Corporate Calendar: Schedule of Activities");
    expect(plain(doc.footer!.left!)).toBe("Updated 11/3/2026 11:00:00 AM");
    expect(outline(doc)).toEqual(["HLTH-20002", "HLTH-20001"]);
  });

  it("Schedule, Title & Summary, Significance and CC ID#, as legacy builds them", () => {
    const row = (over: Partial<ReportRow>) => (planningDoc(ctx([on(20001, "2026-11-10", over)])).blocks[0] as TableBlock).rows[0]!.map((c) => plain(c.runs));
    expect(row({ schedule: "Sample schedule", premierRequested: "Premier Confirmed", keywords: ["Sample", "HQ sample", "Another"], isConfidential: true, city: "Sampleton, SP" })).toEqual([
      "Tue Nov 10 9:00-10:00 AM\nSample schedule\n\nPremier Requested: Confirmed\nTags: HQ sample, Another, Sample",
      "Sampleton - Sample 20001\nNot for Look Ahead Sample details",
      "Sample significance",
      "HLTH-20001\nupdated 1 month ago",
    ]);
    expect(row({ isIssue: true })[2]).toBe("Issue\nSample significance");
    expect(row({ categories: ["Sample issue category"] })[2]).toBe("Issue\nSample significance");
    expect(row({ categories: ["Sample FYI only"] })[2]).toBe("FYI Only\nSample significance");
    // ActivityHandler.ashx.cs:567: the Premier/Tags block opens with its own <br>, a blank line.
    expect(row({ keywords: ["Sample"] })[0]).toBe("Tue Nov 10 9:00-10:00 AM\n\nTags: Sample");
  });

  it("legacy's measured styling: brown 11 pt regular DRAFT AND CONFIDENTIAL, 9 pt footer, #cf7a50 Premier and Tags, 9 pt black created/updated, legacy's widths", () => {
    const doc = planningDoc(ctx([on(20001, "2026-11-10", { premierRequested: "Premier Confirmed", keywords: ["Sample"] })]));
    expect(doc.header!.right).toEqual([{ text: "DRAFT AND CONFIDENTIAL", color: "#a52a2a", size: 11 }]);
    expect(doc.footer!.left).toEqual([{ text: "Updated 11/3/2026 11:00:00 AM", size: 9 }]);
    const table = tables(doc)[0]!;
    // 183.6 / 407.2 / 240.4 / 104 pt: the middle column takes the rest of the line.
    expect(table.widths).toEqual([183.6, "*", 240.4, 104]);
    const [schedule, , , id] = table.rows[0]!;
    expect(schedule!.runs.slice(1)).toEqual([
      { text: "\n\nPremier Requested: ", bold: true, color: "#cf7a50" }, { text: "Confirmed", color: "#cf7a50" },
      { text: "\nTags: ", bold: true, color: "#cf7a50" }, { text: "Sample", color: "#cf7a50" },
    ]);
    expect(id!.runs.at(-1)).toEqual({ text: "\nupdated 1 month ago", size: 9 });
  });

  it("HQ tags first, each group sorted", () => {
    expect(planningTags(["b", "HQ z", "a", "HQ a"])).toEqual(["HQ a", "HQ z", "a", "b"]);
  });

  it("tags in legacy's culture-aware order, not code-unit order: case doesn't put capitals first", () => {
    expect(planningTags(["beta", "Zed", "HQ Zed", "HQ beta", "Apple"])).toEqual(["HQ beta", "HQ Zed", "Apple", "beta", "Zed"]);
  });

  it("no activities: the one table, its header and no rows", () => {
    const doc = planningDoc(ctx([]));
    expect(doc.blocks).toHaveLength(1);
    expect(tables(doc)[0]!.rows).toEqual([]);
  });
});

// Seeded into every list-row field neither report prints, plus the Look Ahead's own facts; none may reach the document.
const NEVER_PRINTED: Partial<ReportRow> = {
  watcherNames: ["MARK-watcher"], lastUpdatedByName: "MARK-updater", leadOrganization: "MARK-lead", translations: ["MARK-translation"],
  governmentRepresentative: "MARK-representative", eventPlanner: "MARK-planner", nrDistribution: "MARK-distribution", nrOrigins: ["MARK-origin"],
  potentialDates: "MARK-potential", venue: "MARK-venue", needsReview: ["active"], initiatives: ["MARK-initiative"],
  executiveSummary: "**MARK-summary** for HQ", hqStatus: "new", hqSection: "issues_and_reports", longTermOutlook: true, nrAt: bc("2026-11-10", "08:00"),
};
// What the other report prints and this one doesn't.
const ONLY_IN_30_60_90: Partial<ReportRow> = { strategy: "MARK-strategy", commMaterials: ["MARK-material"], commContact: { name: "MARK-contact", phone: "MARK-phone" } };
const ONLY_IN_PLANNING: Partial<ReportRow> = { schedule: "MARK-schedule", keywords: ["MARK-keyword"], premierRequested: "MARK-premier" };
const SECTION_VALUES = ["events_and_speeches", "issues_and_reports", "in_the_news", "not_on_la"];
const noHiddenText = (doc: ReportDoc) => {
  const json = JSON.stringify(doc);
  expect(json).not.toContain("MARK-");
  for (const v of SECTION_VALUES) expect(json).not.toContain(v);
  expect(cellTexts(doc).filter((t) => /\b(new|changed)\b|long term outlook|\btrue\b|\bfalse\b/i.test(t))).toEqual([]);
  expect(tables(doc).flatMap((t) => t.rows.flatMap((r) => r.flatMap((cell) => cell.runs))).filter((r) => r.color === COLOURS.flag)).toEqual([]);
};

describe("what a 30/60/90 or Planning row never prints", () => {
  for (const isHq of [false, true]) {
    it(`30/60/90, ${isHq ? "HQ" : "a ministry"}: no Executive Summary, NEW or CHANGED, Look Ahead section, nor any list field it doesn't show`, () => {
      // The contact's phone is never printed; its name is, so it is left as the sample's.
      const doc = thirtySixtyNinetyDoc({ ...ctx([on(20001, "2026-11-10", { ...NEVER_PRINTED, ...ONLY_IN_PLANNING, commContact: { name: "Robin Staff", phone: "MARK-phone" } })]), isHq });
      expect(cellTexts(doc).some((t) => t.includes("HLTH-20001"))).toBe(true);
      noHiddenText(doc);
    });
    it(`Planning, ${isHq ? "HQ" : "a ministry"}: no Executive Summary, NEW or CHANGED, Look Ahead section, nor any list field it doesn't show`, () => {
      const doc = planningDoc({ ...ctx([on(20001, "2026-11-10", { ...NEVER_PRINTED, ...ONLY_IN_30_60_90 })]), isHq });
      expect(cellTexts(doc).some((t) => t.includes("HLTH-20001"))).toBe(true);
      noHiddenText(doc);
    });
  }
});

describe("a 30/60/90 or Planning row with no start date", () => {
  // Legacy had none (survey 4.5) and saving requires both dates; an imported one must still not crash.
  const undated = (id: number, endAt: string | null) => reportRow({ id, title: `Sample ${id}`, startAt: null, endAt, isConfirmed: false, potentialDates: "Sample spring" });
  // In the reader's order: undated rows last (legacyReportOrder, NULLS LAST).
  const rows = [on(20001, "2026-11-10"), on(20003, "2026-12-10"), undated(20002, bc("2026-11-11", "10:00")), undated(20004, null)];

  it("30/60/90: an undated row never ends a month (a null start >= the next month is false), so it joins the month open when the dated rows run out", () => {
    const doc = thirtySixtyNinetyDoc(ctx(rows, { filter: { from: "2026-11-03" } }));
    expect(outline(doc)).toEqual(["# 30 / 60 / 90 REPORT", "# November 2026", "HLTH-20001", "---", "# December 2026", "HLTH-20003", "HLTH-20002", "HLTH-20004", "---", "# January 2027"]);
    expect(tables(doc)[1]!.rows.map((r) => plain(r[0]!.runs))).toEqual(["Thu Dec 10 9:00-10:00 AM", "Sample spring", "Sample spring"]);
  });

  it("30/60/90: a dated row after the last month closes every month before the undated rows, so they are dropped with it", () => {
    // Legacy can't be compared here: its in-memory OrderBy on StartDateTime.Value threw on a null start (ActivityHandler.ashx.cs:47).
    const later = [on(20001, "2026-11-10"), on(20005, "2027-02-01"), undated(20002, bc("2026-11-11", "10:00"))];
    expect(outline(thirtySixtyNinetyDoc(ctx(later, { filter: { from: "2026-11-03" } })))).toEqual(["# 30 / 60 / 90 REPORT", "# November 2026", "HLTH-20001", "---", "# December 2026", "---", "# January 2027"]);
  });

  it("Planning: its potential dates in the Schedule", () => {
    const doc = planningDoc(ctx(rows));
    expect(outline(doc)).toEqual(["HLTH-20001", "HLTH-20003", "HLTH-20002", "HLTH-20004"]);
    expect(tables(doc)[0]!.rows.map((r) => plain(r[0]!.runs))).toEqual(["Tue Nov 10 9:00-10:00 AM", "Thu Dec 10 9:00-10:00 AM", "Sample spring", "Sample spring"]);
  });
});

// Calendar.SysAdmin, which the shared world doesn't seed: one in Health, one in HQ. Fictional ids.
const SYS_ADMINS = { sysAdmin: "00000000-0000-4000-8000-000000000501", hqSysAdmin: "00000000-0000-4000-8000-000000000502" } as const;
type Role = Who | keyof typeof SYS_ADMINS;

describe("the 30/60/90 and Planning reports at the built document, through the reader (spec addendum §6)", () => {
  let tdb: TestDatabase;
  let w: World;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    const app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
    for (const [who, org] of [["sysAdmin", "health"], ["hqSysAdmin", "gcpe-hq"]] as const) {
      await projectUser(app, { id: SYS_ADMINS[who], email: `${who}@example.test`, displayName: `Sample ${who}`, isActive: true, calendarRole: "Calendar.SysAdmin", organizationKeys: [org] });
    }
    // Each report prints one of strategy and schedule and not the other: a SHOWN- marker proves the check can see a field.
    const base = { hqComments: "**MARK-summary** for HQ", hqStatus: "new" as const, leadOrganization: "MARK-lead", translations: ["MARK-translation"], strategy: "SHOWN-strategy", schedule: "SHOWN-schedule" };
    for (const [hqSection, day] of [["events_and_speeches", "2046-03-10"], ["issues_and_reports", "2046-03-10"], ["in_the_news", "2046-03-11"]] as const) {
      await insertRaw(tdb.db, { ...base, title: `Sample ${day}`, hqSection, startAt: new Date(`${day}T17:00:00Z`), endAt: new Date(`${day}T18:00:00Z`) });
    }
    await insertRaw(tdb.db, { ...base, title: "Sample second event", hqStatus: "changed", hqSection: "events_and_speeches", startAt: new Date("2046-03-12T17:00:00Z"), endAt: new Date("2046-03-12T18:00:00Z") });
    await insertRaw(tdb.db, { ...base, title: "Sample undated", hqSection: "issues_and_reports", startAt: null, endAt: new Date("2046-03-11T18:00:00Z"), isConfirmed: false, potentialDates: "Sample spring" });
  });
  afterAll(() => tdb.drop());

  const dataOf = async (who: Role, showHqCommentsField: boolean) => {
    const rules = { ...TEST_RULES, showHqCommentsField };
    const actor = (await loadCalendarActor(tdb.db, who in SYS_ADMINS ? SYS_ADMINS[who as keyof typeof SYS_ADMINS] : w.as[who as Who].id))!;
    const d = await reportData({ db: tdb.db, rules, subscribers: [], now: () => FIXED_NOW }, actor, q({ filter: { from: "2046-03-10", to: "2046-03-12" } }));
    // A Finance Editor sees none of these Health activities: not visible is never a row.
    expect(d.rows).toHaveLength(who === "financeEditor" ? 0 : 5);
    return d;
  };
  const SHOWN: Record<"30-60-90" | "planning", [string, string]> = { "30-60-90": ["SHOWN-strategy", "SHOWN-schedule"], planning: ["SHOWN-schedule", "SHOWN-strategy"] };

  const WHO: Role[] = ["readOnly", "editor", "financeEditor", "advanced", "admin", "sysAdmin", "hqReadOnly", "hqEditor", "hqAdvanced", "hqAdmin", "hqSysAdmin"];
  for (const who of WHO) {
    for (const show of [false, true]) {
      for (const kind of ["30-60-90", "planning"] as const) {
        it(`${who}${show ? " (ShowHqCommentsField on)" : ""}, ${kind}: every row, no Executive Summary, no NEW or CHANGED, no other list field`, async () => {
          const doc = buildReport(kind, await dataOf(who, show), null);
          const sees = who !== "financeEditor";
          expect(cellTexts(doc).filter((t) => /^HLTH-\d+/.test(t))).toHaveLength(sees ? 5 : 0);
          const [shown, hidden] = SHOWN[kind];
          if (sees) expect(JSON.stringify(doc)).toContain(shown);
          expect(JSON.stringify(doc)).not.toContain(sees ? hidden : "SHOWN-");
          noHiddenText(doc);
        });
      }
    }
  }

  it("the controls: the reader hands an HQ Administrator, and a Health Editor with ShowHqCommentsField on, the summary and the flags; neither report prints them", async () => {
    for (const [who, show] of [["hqAdmin", false], ["editor", true]] as const) {
      const d = await dataOf(who, show);
      expect(d.rows.filter((r) => r.executiveSummary?.includes("MARK-summary"))).toHaveLength(5);
      expect(d.rows.map((r) => r.hqStatus).sort()).toEqual(["changed", "new", "new", "new", "new"]);
      for (const kind of ["30-60-90", "planning"] as const) noHiddenText(buildReport(kind, d, null));
    }
  });

  it("buildReport: each kind's own document, the CC ID# linked to the activity when there is an origin", async () => {
    const d = await dataOf("hqAdmin", false);
    const docs = Object.fromEntries(REPORT_KINDS.map((k) => [k, buildReport(k, d, "https://staff.example.test")])) as Record<ReportKind, ReportDoc>;
    expect(REPORT_KINDS.map((k) => [docs[k].title, docs[k].page])).toEqual([
      ["Look Ahead", "letter-portrait"], ["Exec Look Ahead", "letter-portrait"], ["30 / 60 / 90 Report", "letter-portrait"], ["Planning Report", "legal-landscape"],
    ]);
    const id = d.rows[0]!.id;
    for (const k of REPORT_KINDS) expect(JSON.stringify(docs[k])).toContain(`"link":"https://staff.example.test/hub/calendar/activities/${id}"`);
    expect(JSON.stringify(buildReport("planning", d, null))).not.toContain('"link"');
  });
});
