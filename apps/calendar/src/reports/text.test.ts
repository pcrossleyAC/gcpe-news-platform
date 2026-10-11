import { describe, expect, it } from "vitest";
import { TEST_RULES } from "../../test/helpers";
import { bc, plain, reportRow } from "../../test/report-rows";
import { addMonths, longDay, shortDay, titleDay, updatedLong, updatedNumeric } from "./dates";
import {
  categoryText, cleanTitle, COLOURS, createdOrUpdated, detailedRuns, executiveSummaryRuns, formatTitle, lastUpdatedText, linkify, lookAheadText, minIdRuns, rlsLines, titleDetailsRuns,
} from "./text";

const tz = TEST_RULES.timeZone;
// 2026-11-03 11:00 BC, a Tuesday.
const NOW = new Date("2026-11-03T18:00:00Z");
const c = { rules: TEST_RULES, isHq: false, now: NOW, today: "2026-11-03", origin: "https://staff.example.test" };

describe("report dates in legacy's formats", () => {
  it("days, titles, months and the Updated stamps", () => {
    expect(longDay("2026-11-03")).toBe("Tuesday, November 3, 2026");
    expect(shortDay("2026-11-03")).toBe("Tue Nov 3");
    expect(titleDay("2026-05-01", false)).toBe("Friday, May. 1");
    expect(titleDay("2026-11-03", true)).toBe("Tuesday, Nov. 3, 2026");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-11-15", 1)).toBe("2026-12-15");
    expect(updatedLong(NOW, tz)).toBe("Updated Tuesday, Nov 3, 2026 11:00 AM");
    expect(updatedNumeric(new Date("2026-11-03T20:05:09Z"), tz)).toBe("Updated 11/3/2026 1:05:09 PM");
  });
});

describe("report text (ActivityHandler.ashx.cs:1087-1257)", () => {
  it("a title drops the raw **CONFIDENTIAL** marker and a city its suffix and the undecided city", () => {
    expect(cleanTitle("**CONFIDENTIAL** Sample launch")).toBe("Sample launch");
    expect(cleanTitle("Sample **confidential** launch")).toBe("Sample launch");
    expect(cleanTitle("Sample **bold** launch")).toBe("Sample **bold** launch");
    expect(formatTitle(reportRow({ city: "Sampleton, SP" }), TEST_RULES)).toBe("Sampleton - Sample activity");
    expect(formatTitle(reportRow({ city: "Sample undecided city" }), TEST_RULES)).toBe("Sample activity");
    expect(formatTitle(reportRow({ city: null }), TEST_RULES)).toBe("Sample activity");
  });

  it("the Executive Summary's **bold** and _italic_ become styles; a bare ** is no summary", () => {
    expect(executiveSummaryRuns("**Sampleton -- Sample launch:** details _soon_\r\nNext line")).toEqual([
      { text: "Sampleton -- Sample launch:", bold: true },
      { text: " details " },
      { text: "soon", italic: true },
      { text: "\nNext line" },
    ]);
    expect(executiveSummaryRuns("**")).toBeNull();
    expect(executiveSummaryRuns(null)).toBeNull();
    expect(executiveSummaryRuns("an unclosed ** marker")).toEqual([{ text: "an unclosed ** marker" }]);
  });

  it("the first web address becomes a link: http:// shown without its scheme, a [label] before it used as its text", () => {
    expect(linkify([{ text: "See http://example.test/page/ for more" }])).toEqual([
      { text: "See " },
      { text: "example.test/page", link: "http://example.test/page", underline: true, color: COLOURS.link },
      { text: " for more" },
    ]);
    expect(linkify([{ text: "Title", bold: true }, { text: ": read [the notice]https://example.test/n" }])).toEqual([
      { text: "Title", bold: true },
      { text: ": read " },
      { text: "the notice", link: "https://example.test/n", underline: true, color: COLOURS.link },
    ]);
    expect(linkify([{ text: "No address, and javascript:alert(1) is not one" }])).toEqual([{ text: "No address, and javascript:alert(1) is not one" }]);
  });

  it("title and details: bold title, the red Not for Look Ahead, the 30/60/90's significance at 9 pt", () => {
    const row = reportRow({ isConfidential: true });
    expect(titleDetailsRuns(row, TEST_RULES, { thirtySixtyNinety: false })).toEqual([
      { text: "Sample City - Sample activity", bold: true },
      { text: ": " },
      { text: "Not for Look Ahead ", color: COLOURS.darkRed },
      { text: "Sample details" },
    ]);
    expect(plain(titleDetailsRuns(reportRow(), TEST_RULES, { thirtySixtyNinety: true }))).toBe("Sample City - Sample activity: Sample details\nSignificance: Sample significance");
  });

  it("the Look Ahead's text: the Executive Summary when the viewer has it, the initiatives after", () => {
    expect(plain(lookAheadText(reportRow({ initiatives: ["SI", "SJ"] }), TEST_RULES, { titleOnly: false }))).toBe("Sample City - Sample activity: Sample details SI, SJ");
    expect(plain(lookAheadText(reportRow({ executiveSummary: "**Summary** text" }), TEST_RULES, { titleOnly: false }))).toBe("Summary text");
    expect(plain(lookAheadText(reportRow(), TEST_RULES, { titleOnly: true }))).toBe("Sample City - Sample activity");
  });

  it("created or updated, as the list says it; the Exec Look Ahead's Last updated says it once", () => {
    expect(createdOrUpdated(reportRow({ status: "new", createdAt: "2026-11-02T18:00:00Z" }), NOW, tz)).toBe("created yesterday");
    expect(createdOrUpdated(reportRow({ lastUpdatedAt: "2026-09-01T18:00:00Z" }), NOW, tz)).toBe("updated 2 months ago");
    expect(lastUpdatedText(reportRow({ lastUpdatedAt: "2026-11-03T16:15:00Z" }), NOW, tz)).toBe("Last updated today at 9:15 AM");
    expect(lastUpdatedText(reportRow({ lastUpdatedAt: "2026-11-02T22:00:00Z" }), NOW, tz)).toBe("Last updated yesterday at 3:00 PM");
    expect(lastUpdatedText(reportRow({ lastUpdatedAt: "2026-09-01T18:00:00Z" }), NOW, tz)).toBe("Last updated 2 months ago");
  });

  it("the Exec Look Ahead's row: title, details, significance, City: Venue, Last updated; the typed Other City, not Other...", () => {
    const runs = detailedRuns(reportRow({ city: "Sampleton, SP", venue: "Sample Hall", title: "**CONFIDENTIAL** Sample launch" }), c);
    expect(plain(runs)).toBe("Sample launch\nSample details\nSample significance\nSampleton: Sample Hall  Last updated 1 month ago");
    expect(runs.find((r) => r.text === "Sampleton: Sample Hall")).toMatchObject({ bold: true });
    expect(plain(detailedRuns(reportRow({ city: null, venue: "", details: "", significance: "" }), c))).toBe("Sample activity\nLast updated 1 month ago");
    // Legacy breaks the line before City: Venue only after a significance; otherwise it follows on after a space (ActivityHandler.ashx.cs:1000-1033).
    expect(plain(detailedRuns(reportRow({ city: "Sampleton, SP", venue: "Sample Hall", significance: "" }), c))).toBe("Sample activity\nSample details Sampleton: Sample Hall  Last updated 1 month ago");
  });

  it("the Executive Summary drops the private-use characters it marks styles with, so user text can't inject bold or italic", () => {
    expect(executiveSummaryRuns("a\uE000b **x** _y_\uE003")).toEqual([{ text: "ab " }, { text: "x", bold: true }, { text: " " }, { text: "y", italic: true }]);
    expect(executiveSummaryRuns("\uE000Sample injected\uE001 and \uE002more\uE003")).toEqual([{ text: "Sample injected and more" }]);
  });

  it("the CC ID# links to the activity in the staff app, under the tenant's abbreviation", () => {
    expect(minIdRuns(reportRow(), c)).toEqual([{ text: "HLTH-20001", color: COLOURS.link, link: "https://staff.example.test/hub/calendar/activities/20001" }]);
    expect(minIdRuns(reportRow({ ministryAbbreviation: "FIN" }), { ...c, origin: null })).toEqual([{ text: "FN-20001", color: COLOURS.link }]);
  });

  it("RLS: origin above material, the first rule wins, Report only outside Events, both fact sheet spellings (C148), the NR time on its day", () => {
    const day = "2026-11-10";
    const r = (over: object) => reportRow(over);
    expect(rlsLines(r({}), TEST_RULES, { table: "events", day })).toEqual(["-"]);
    expect(rlsLines(r({ nrOrigins: ["Sample origin"], commMaterials: ["Sample news release"] }), TEST_RULES, { table: "events", day })).toEqual(["Gov", "NR"]);
    expect(rlsLines(r({ commMaterials: ["Sample report"] }), TEST_RULES, { table: "events", day })).toEqual(["-"]);
    expect(rlsLines(r({ commMaterials: ["Sample report"] }), TEST_RULES, { table: "issues", day: null })).toEqual(["Report"]);
    expect(rlsLines(r({ commMaterials: ["Sample factsheet"] }), TEST_RULES, { table: "events", day })).toEqual(["Fact Sheet"]);
    const nr = { commMaterials: ["Sample news release"], nrAt: bc(day, "13:15") };
    expect(rlsLines(r(nr), TEST_RULES, { table: "events", day })).toEqual(["NR", "1:15 pm"]);
    expect(rlsLines(r(nr), TEST_RULES, { table: "events", day: "2026-11-11" })).toEqual(["NR"]);
    expect(rlsLines(r({ ...nr, nrAt: bc(day, "09:00") }), TEST_RULES, { table: "events", day })).toEqual(["NR"]);
    expect(rlsLines(r({ commMaterials: ["Sample newsletter"], nrAt: bc(day, "13:15") }), TEST_RULES, { table: "news", day })).toEqual(["e-news"]);
  });

  it("the Category column: Issue, HQ's FYI unless only the broadcast category, else the names", () => {
    expect(categoryText(reportRow({ isIssue: true }), TEST_RULES, true)).toBe("Issue");
    expect(categoryText(reportRow(), TEST_RULES, true)).toBe("FYI");
    expect(categoryText(reportRow({ categories: [" Sample  broadcast"] }), TEST_RULES, true)).toBe(" Sample  broadcast");
    expect(categoryText(reportRow({ categories: ["Sample plain category", "Sample other"] }), TEST_RULES, false)).toBe("Sample plain category, Sample other");
  });
});
