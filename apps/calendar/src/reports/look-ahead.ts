import { friendlyDateParts, type FriendlyDateParts, type ListQuery } from "@gcpe/calendar-contract";
import { addDays, bcMidnight, wallClock, type WallClock } from "../time";
import { ReportTooLargeError, type ReportRow } from "./data";
import { addMonths, longDay, shortDay, titleDay, updatedLong, weekdayOf } from "./dates";
import { cm, inch, type Block, type Cell, type Grid, type HeadingBlock, type LegendItem, type ReportDoc, type Run, type TableBlock } from "./model";
import {
  categoryText, COLOURS, detailedRuns, filterLine, flagRuns, leadOf, lookAheadText, minIdRuns, rlsLines, type LookAheadTable, type TextContext,
} from "./text";

/** The tenant's pictures at legacy's 96 ppi: the cover 765 x 990 px (LookAheadReport.rdlc's background), the logo 153 x 41 px. */
const COVER_SIZE = { width: 765 * 0.75, height: 990 * 0.75 };
const LOGO_SIZE = { width: 153 * 0.75, height: 41 * 0.75 };

/** A Look Ahead covers at most this many days; a longer range is refused before anything is drawn. */
export const LOOK_AHEAD_MAX_DAYS = 366;

export interface LookAheadContext extends TextContext {
  rows: ReportRow[];
  q: ListQuery;
  /** Organizations carrying the tenant's consultations abbreviation (ListScope.consultationsKeys). */
  consultationsKeys: readonly string[];
}

export interface LookAheadRange {
  from: string;
  to: string;
  /** The Long Term Outlook section and its legend entry. */
  includeOutlook: boolean;
  /** Activities starting after this instant belong to the Long Term Outlook, whether or not it is shown. */
  outlookAfter: Date | null;
}

/** ActivityHandler.ashx.cs:640-661: the filter's From or today; no To runs 60 days (the Exec, one month) and adds the Outlook. */
export function lookAheadRange(q: ListQuery, today: string, timeZone: string, detailed: boolean): LookAheadRange {
  const f = q.filter;
  const from = f.from ?? today;
  const ownTo = f.to !== null && !f.thisDayOnly;
  const to = ownTo ? f.to! : f.thisDayOnly ? from : detailed ? addMonths(from, 1) : addDays(from, 59);
  return { from, to, includeOutlook: !ownTo && !f.thisDayOnly, outlookAfter: f.to === null ? bcMidnight(addDays(from, 60), timeZone) : null };
}

/** Legacy's BelongsToAwarenessConsultationReport: rows that leave the day tables. The consultations ministry's rows appear nowhere: their section is dropped. */
function elsewhere(row: ReportRow, c: LookAheadContext, outlookAfter: Date | null): "consultations" | "awareness" | "outlook" | null {
  if (row.ministryKey !== null && c.consultationsKeys.includes(row.ministryKey)) return "consultations";
  if (row.categoryIds.some((id) => c.rules.awarenessCategoryIds.includes(id))) return "awareness";
  if (outlookAfter && row.startAt && new Date(row.startAt) > outlookAfter) return "outlook";
  return null;
}

/** A row's BC dates and where it goes, worked out once: the day loops do no time-zone work per row per day. */
interface Placed {
  row: ReportRow;
  /** BC dates; null with no start or no end. */
  startDay: string | null;
  endDay: string | null;
  /** Legacy's IsTimeTBD: an unconfirmed 8 AM to 6 PM day. */
  tbd: boolean;
  place: ReturnType<typeof elsewhere>;
  /** In Issues and Reports, and so out of the day tables. */
  forIssues: boolean;
  /** Legacy skips a confidential Not on LA row everywhere but Awareness and the Outlook. */
  skipped: boolean;
}

/** Legacy's (End - Start).Days on BC wall-clock times: a daylight-saving change doesn't shorten the span. */
const wallMs = (w: WallClock) => {
  const [y, m, d] = w.date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) + w.secondsOfDay * 1000;
};

function placedOf(row: ReportRow, c: LookAheadContext, range: LookAheadRange): Placed {
  const tz = c.rules.timeZone;
  const s = row.startAt ? wallClock(new Date(row.startAt), tz) : null;
  const e = row.endAt ? wallClock(new Date(row.endAt), tz) : null;
  const spanDays = s && e ? Math.trunc((wallMs(e) - wallMs(s)) / 86_400_000) : 0;
  return {
    row,
    startDay: s?.date ?? null,
    endDay: e?.date ?? null,
    tbd: !!s && !!e && !row.isConfirmed && s.date === e.date && s.time === "08:00" && e.time === "18:00",
    place: elsewhere(row, c, range.outlookAfter),
    // Legacy's NotForLookAhead also counted the "CONFIDENTIAL or EMBARGOED" category, inactive since 2015 (Metadata.cs:27-32).
    forIssues: c.isHq ? row.hqSection === "issues_and_reports" : !row.isConfidential && !row.isConfirmed && spanDays >= 5,
    skipped: row.isConfidential && row.hqSection === "not_on_la",
  };
}

interface LaRow {
  row: ReportRow;
  date: FriendlyDateParts;
  flag: boolean;
  text: Run[];
  category: string;
  rls: string[];
  issue: boolean;
}

/**
 * Legacy's GenerateLookAheadActivities (ActivityHandler.ashx.cs:899-1061) for rows already chosen,
 * in list order: one day's Events or In the News rows, or (no day) Issues and Reports, in legacy's
 * order: time-TBD and multi-day rows first in Events; in In the News, time-TBD rows on top, then
 * one-day rows, multi-day rows last.
 */
function sectionRows(c: LookAheadContext, chosen: readonly Placed[], o: { table: LookAheadTable; day: string | null; detailed: boolean }): LaRow[] {
  const tz = c.rules.timeZone;
  const inTheNews = o.table !== "events";
  const out: LaRow[] = [];
  let firstBlock = 0;
  for (const p of chosen) {
    const { row } = p;
    let at = out.length;
    if (o.day !== null) {
      if (p.tbd) {
        at = inTheNews ? 0 : firstBlock;
        firstBlock++;
      } else if (inTheNews === (p.startDay === p.endDay)) {
        at = firstBlock++;
      }
    }
    const detailed = o.detailed && ["events_and_speeches", "issues_and_reports", "in_the_news"].includes(row.hqSection);
    out.splice(at, 0, {
      row,
      date: friendlyDateParts(row, { timeZone: tz, today: c.today, weekday: false, endTime: false, ...(o.day ? { referenceDay: o.day } : {}) }),
      flag: o.day === null || p.startDay === o.day,
      text: detailed ? detailedRuns(row, c) : lookAheadText(row, c.rules, { titleOnly: false }),
      category: categoryText(row, c.rules, c.isHq),
      rls: rlsLines(row, c.rules, { table: o.table, day: o.day }),
      issue: (row.isIssue && inTheNews) || (o.detailed && row.isIssue),
    });
  }
  return out;
}

/**
 * Each day's Events and In the News rows, in list order: a row is on every day from its start's to
 * its end's (it starts before the day ends and ends on or after its midnight), so a day's lookup
 * costs only that day's rows.
 */
function dayTables(placed: readonly Placed[], days: readonly string[]): { events: Placed[][]; news: Placed[][] } {
  const events = days.map((): Placed[] => []);
  const news = days.map((): Placed[] => []);
  const index = new Map(days.map((d, i) => [d, i]));
  const first = days[0]!;
  const last = days[days.length - 1]!;
  for (const p of placed) {
    if (p.place !== null || p.skipped || p.forIssues || p.startDay === null || p.endDay === null) continue;
    const table = p.row.hqSection === "events_and_speeches" ? events : p.row.hqSection === "in_the_news" ? news : null;
    if (!table || p.startDay > last || p.endDay < first) continue;
    const lo = p.startDay <= first ? 0 : index.get(p.startDay)!;
    const hi = p.endDay >= last ? days.length - 1 : index.get(p.endDay)!;
    for (let i = lo; i <= hi; i++) table[i]!.push(p);
  }
  return { events, news };
}

/** The subreports' grid: LightGrey 1 pt lines, 2 pt padding (LookAheadEventSpeechRlsSubreport.rdlc and its siblings). */
const GRID: Grid = { colour: COLOURS.grid, width: 1, padding: 2 };
/** Legacy's TitleDetails cell: 8 pt under the text, not 2. */
const DETAILS_PAD = 6;
type Align = Cell["align"];
/** Column titles: 11 pt bold white, each aligned as its RDLC textbox. */
const header = (labels: [string, Align?][], fill: string): Cell[] =>
  labels.map(([text, align]) => ({ runs: [{ text, bold: true, color: COLOURS.white, size: 11 }], fill, ...(align ? { align } : {}) }));
type HeadingOptions = { size?: number; align?: "left" | "center"; underline?: boolean; colour?: string; spaceBefore?: number; spaceAfter?: number; bookmark?: string };
const title = (text: string, o: HeadingOptions = {}): Omit<HeadingBlock, "kind"> => ({
  runs: [{ text, bold: true, ...(o.underline ? { underline: true } : {}), ...(o.colour ? { color: o.colour } : {}) }],
  size: o.size ?? 14,
  ...(o.align ? { align: o.align } : {}),
  ...(o.spaceBefore !== undefined ? { spaceBefore: o.spaceBefore } : {}),
  ...(o.spaceAfter !== undefined ? { spaceAfter: o.spaceAfter } : {}),
  ...(o.bookmark ? { bookmark: o.bookmark } : {}),
});
const heading = (text: string, o: HeadingOptions = {}): Block => ({ kind: "heading", ...title(text, o) });
/** "Inside Government", "Outside Government": 16 pt bold, underlined (LookAheadReport.rdlc). */
const sideHeading = (text: string, bookmark: string) => heading(text, { size: 16, underline: true, spaceBefore: 2, spaceAfter: 2, bookmark });
/** A day's heading and "No Activities for …": 16 pt bold navy, centred (LookAheadEventSpeechRlsSubreport.rdlc Textbox1, LookAheadReport.rdlc textbox1). */
const dayHeading = (text: string) => title(text, { size: 16, align: "center", colour: COLOURS.heading, spaceBefore: 0, spaceAfter: 0 });
/** A section's title: 14 pt bold navy with 2 pt padding (the subreports' Textbox2). */
const sectionTitle = (text: string, bookmark?: string) => title(text, { colour: COLOURS.heading, spaceBefore: 2, spaceAfter: 2, ...(bookmark ? { bookmark } : {}) });

function dateRuns(r: { date: FriendlyDateParts; flag: boolean; row: ReportRow }, colour?: string): Run[] {
  const runs: Run[] = [{ text: r.date.text, wrapAtHyphen: true, ...(colour ? { color: colour } : {}) }];
  if (r.date.pending) runs.push({ text: `${r.date.text ? " " : ""}${r.date.pending}`, bold: true, color: COLOURS.pending });
  return r.flag ? [...runs, ...flagRuns(r.row)] : runs;
}

/** LookAheadEventSpeechRlsSubreport.rdlc: the day and section titles repeat with the header on every page the day runs onto. */
function eventsTable(c: LookAheadContext, day: string, rows: LaRow[]): TableBlock {
  return {
    kind: "table",
    widths: [inch(1), inch(0.65827), inch(4.86851), inch(0.8), inch(0.65827)],
    titles: [dayHeading(longDay(day)), sectionTitle("Events, Speeches & Releases")],
    header: header([[shortDay(day)], ["Lead", "center"], ["Activity/Details"], ["RLS", "center"], ["CC ID#", "center"]], COLOURS.events),
    grid: GRID,
    rows: rows.map((r, i) => {
      // Zebra on the odd rows; the Exec's issue purple on Activity/Details alone.
      const zebra = i % 2 === 0 ? { fill: COLOURS.zebra } : {};
      return [
        { runs: dateRuns(r, COLOURS.white), fill: COLOURS.events },
        { runs: [{ text: leadOf(r.row, c.rules) }], align: "center", ...zebra },
        { runs: r.text, paddingBottom: DETAILS_PAD, ...(r.issue ? { fill: COLOURS.issues } : zebra) },
        { runs: [{ text: r.rls.join("\n") }], align: "center", ...zebra },
        { runs: minIdRuns(r.row, c), align: "center", ...zebra },
      ];
    }),
  };
}

/**
 * LookAheadIssuesSubreport.rdlc, for Issues and Reports and each day's In the News: Activity/Details purple
 * on an issue's row and Category on "Issue"; the CC ID# and Rls never filled.
 */
function listTable(c: LookAheadContext, first: string, sectionName: string, rows: LaRow[], dateFill: string, bookmark?: string): TableBlock {
  const purple = { fill: COLOURS.issues };
  return {
    kind: "table",
    widths: [inch(1), inch(0.65827), inch(4.9), inch(0.8), inch(0.6)],
    titles: [sectionTitle(sectionName, bookmark)],
    header: header([[first], ["CC ID#", "center"], ["Activity/Details"], ["Category", "center"], ["Rls", "center"]], COLOURS.listHeader),
    grid: GRID,
    rows: rows.map((r) => [
      { runs: dateRuns(r), fill: dateFill },
      { runs: minIdRuns(r.row, c), align: "center" },
      { runs: r.text, paddingBottom: DETAILS_PAD, ...(r.issue ? purple : {}) },
      { runs: [{ text: r.category }], align: "center", ...(r.category === "Issue" ? purple : {}) },
      { runs: [{ text: r.rls.join("\n") }], align: "center" },
    ]),
  };
}

/** Awareness Dates' or the Long Term Outlook's rows (ActivityHandler.ashx.cs:808-838): list order, no day split; HQ's Outlook only those marked for it. */
function laterRows(c: LookAheadContext, placed: readonly Placed[], which: "awareness" | "outlook"): ReportRow[] {
  return placed.filter((p) => p.place === which && (which === "awareness" || !c.isHq || p.row.longTermOutlook)).map((p) => p.row);
}

/**
 * LookAheadAwarenessConsultationOutlookSubreport.rdlc: Awareness's dates green; the Outlook's header
 * brick red and its rows banded, the even ones pale blue across the row.
 */
function laterTable(c: LookAheadContext, rows: ReportRow[], which: "awareness" | "outlook"): TableBlock {
  const outlook = which === "outlook";
  return {
    kind: "table",
    widths: [inch(1), inch(5.98505), inch(1)],
    header: header([["Date"], [outlook ? "Activity/Details" : "Name"], ["CC ID#", "center"]], outlook ? COLOURS.outlookHeader : COLOURS.listHeader),
    grid: GRID,
    rows: rows.map((row, i) => {
      const band = outlook && i % 2 === 1 ? { fill: COLOURS.outlook } : {};
      return [
        { runs: dateRuns({ row, flag: true, date: friendlyDateParts(row, { timeZone: c.rules.timeZone, today: c.today, weekday: false }) }), ...(outlook ? band : { fill: COLOURS.awareness }) },
        { runs: lookAheadText(row, c.rules, { titleOnly: !outlook }), paddingBottom: DETAILS_PAD, ...band },
        { runs: minIdRuns(row, c), align: "center", ...band },
      ];
    }),
  };
}

/** The range's days, refused (ReportTooLargeError) past LOOK_AHEAD_MAX_DAYS before anything is built. */
export function lookAheadDays(range: Pick<LookAheadRange, "from" | "to">): string[] {
  const days: string[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) {
    if (days.length === LOOK_AHEAD_MAX_DAYS) throw new ReportTooLargeError("days in the range");
    days.push(d);
  }
  return days;
}

/**
 * The Look Ahead (spec addendum §10.2; Reports/LookAheadReport.rdlc) and, with `detailed`, the Exec
 * Look Ahead (§10.3). Six sections: legacy's "Consultations and Dialogues" is dropped (carry-forward § 5g),
 * though the cover's legend still names it, as legacy's did.
 */
export function lookAheadDoc(c: LookAheadContext, o: { detailed: boolean; maxRows?: number }): ReportDoc {
  const range = lookAheadRange(c.q, c.today, c.rules.timeZone, o.detailed);
  const days = lookAheadDays(range);
  const placed = c.rows.map((row) => placedOf(row, c, range));
  const { events, news } = dayTables(placed, days);
  const issueRows = placed.filter((p) => p.place === null && !p.skipped && p.forIssues);
  const awareness = laterRows(c, placed, "awareness");
  const outlook = range.includeOutlook ? laterRows(c, placed, "outlook") : [];
  // Every table row this document would hold, counted before any is drawn.
  const rowCount = [...events, ...news].reduce((n, d) => n + d.length, issueRows.length + awareness.length + outlook.length);
  if (o.maxRows !== undefined && rowCount > o.maxRows) throw new ReportTooLargeError("rows to print");
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  // Legacy's own quirk, kept: the start shows its year only when both ends share it (ActivityHandler.ashx.cs:668-673).
  const title = c.q.filter.thisDayOnly ? titleDay(range.from, true) : `${titleDay(range.from, sameYear)} to ${titleDay(range.to, true)}`;
  // ActivityHandler.ashx.cs:760-774: legacy's legend, Consultations and Dialogues included, though its section is dropped (C185).
  const legend: LegendItem[] = [
    { colour: COLOURS.events, runs: [{ text: "Events, Speeches and Releases", bold: true }, { text: " (Inside Government)" }] },
    { colour: COLOURS.issues, runs: [{ text: "Issues and Reports", bold: true }] },
    { colour: COLOURS.consultations, runs: [{ text: "Consultations and Dialogues", bold: true }] },
    { colour: COLOURS.news, runs: [{ text: "In the News", bold: true }, { text: " (Outside Government)" }] },
    { colour: COLOURS.awareness, runs: [{ text: "Awareness Dates", bold: true }] },
    ...(range.includeOutlook ? [{ colour: COLOURS.outlook, runs: [{ text: "Long Term Outlook", bold: true }] }] : []),
  ];
  const filter = filterLine(c)[0];
  const blocks: Block[] = [
    {
      kind: "cover",
      image: c.rules.lookAheadCoverImage ? { name: c.rules.lookAheadCoverImage, ...COVER_SIZE } : null,
      organization: c.rules.reports.cover.organization,
      lines: [...c.rules.reports.cover.lines],
      title: [{ text: title, bold: true }],
      filter: filter ? filter.runs : null,
      // LookAheadLegendSubreport.rdlc: "Contents:" 14 pt Gray.
      contents: [{ text: "Contents:", color: COLOURS.grey }],
      legend,
    },
    { kind: "pageBreak" },
    // LookAheadReport.rdlc's DocumentMapLabels: legacy's bookmarks name the sections, not the headings.
    sideHeading("Inside Government", "Events, Speeches and Releases"),
  ];
  // ActivityHandler.ashx.cs:707-731: HQ breaks after every day but a Saturday; everyone, after the last day. Legacy adds the
  // day's rows (plus 2 for its headings) and then tests the total plus them again against 16, counting the day twice: a
  // Saturday breaks from 7 rows, (7 + 2) x 2 > 16, whatever came before it. Kept as legacy had it.
  let sinceBreak = 0;
  days.forEach((day, i) => {
    const rows = sectionRows(c, events[i]!, { table: "events", day, detailed: o.detailed });
    if (rows.length === 0) blocks.push({ kind: "heading", ...dayHeading(`No Activities for ${longDay(day)}`), spaceAfter: 6 });
    else blocks.push(eventsTable(c, day, rows));
    const onPage = rows.length ? rows.length + 2 : 0;
    sinceBreak += onPage;
    if ((c.isHq && (weekdayOf(day) !== 6 || sinceBreak + onPage > 16)) || day === range.to) {
      sinceBreak = 0;
      blocks.push({ kind: "pageBreak" });
    }
  });
  // LookAheadReport.rdlc: an empty subreport draws nothing, its heading and its page break included.
  const issues = sectionRows(c, issueRows, { table: "issues", day: null, detailed: o.detailed });
  if (issues.length) {
    blocks.push(listTable(c, "Date", "ISSUES AND REPORTS", issues, COLOURS.issuesDate, "Issues and Reports"));
    // IssuesSubreport's PageBreakAtEnd is IsAppOwner.
    if (c.isHq) blocks.push({ kind: "pageBreak" });
  }
  blocks.push(sideHeading("Outside Government", "In the News"));
  days.forEach((day, i) => {
    const rows = sectionRows(c, news[i]!, { table: "news", day, detailed: o.detailed });
    if (rows.length) blocks.push(listTable(c, shortDay(day), "In the News", rows, COLOURS.news));
  });
  // RectangleAwarenessPageBreak breaks for HQ only; not when nothing follows it, which would end the PDF on a blank page.
  if (c.isHq && (awareness.length || outlook.length)) blocks.push({ kind: "pageBreak" });
  if (awareness.length) blocks.push({ kind: "heading", ...sectionTitle("AWARENESS DATES", "Awareness Dates") }, laterTable(c, awareness, "awareness"));
  if (outlook.length) {
    // The Awareness subreport's PageBreakAtEnd is IncludeLTOutlook.
    if (awareness.length) blocks.push({ kind: "pageBreak" });
    blocks.push({ kind: "heading", ...sectionTitle("LONG TERM OUTLOOK", "Long Term Outlook") }, laterTable(c, outlook, "outlook"));
  }
  const updated = updatedLong(c.now, c.rules.timeZone);
  const logo = c.rules.lookAheadLogoImage;
  return {
    page: "letter-portrait",
    // LookAheadReport.rdlc: 0.25 in sides, 0.2 in top, a 1.5 cm header and a 0.51 cm footer, no bottom margin.
    margins: [inch(0.25), inch(0.2) + cm(1.5), inch(0.25), cm(0.51181)],
    fontSize: 10,
    // The PDF title legacy's ReportViewer wrote, for both.
    title: "LookAheadReport",
    // The Header textbox: 11 pt, right, 2 pt padding; page 1 black, later pages Brown over the logo.
    firstPage: { header: { right: [{ text: "DRAFT ONLY - NOT FOR CIRCULATION\nInformation is confidential and subject to change" }], size: 11, offset: inch(0.2), padding: 2 }, footer: null },
    header: {
      ...(logo ? { image: { name: logo, ...LOGO_SIZE } } : { left: [{ text: c.rules.reportBanner.province, bold: true }] }),
      right: [{ text: c.rules.reportBanner.confidentiality, color: COLOURS.brown }],
      size: 11,
      offset: inch(0.2),
      padding: 2,
    },
    // ExecutionTime at the left; the CHANGED note, three spaces and the page numbers right-aligned in one run, all 9 pt.
    footer: {
      left: [{ text: updated }],
      right: [{ text: '"CHANGED" applies to major detail or date changes only (not time switches)   ' }],
      pageNumbers: true,
      size: 9,
      offset: cm(0.03528),
      rightOffset: cm(0.07056),
    },
    blocks,
  };
}
