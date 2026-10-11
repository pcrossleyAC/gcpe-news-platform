import { friendlyDateParts, type FriendlyDateParts, type ListQuery } from "@gcpe/calendar-contract";
import { addDays, bcMidnight, wallClock, type WallClock } from "../time";
import { ReportTooLargeError, type ReportRow } from "./data";
import { addMonths, longDay, shortDay, titleDay, updatedLong, weekdayOf } from "./dates";
import type { Block, Cell, ReportDoc, Run } from "./model";
import {
  categoryText, COLOURS, detailedRuns, flagRuns, leadOf, lookAheadText, minIdRuns, rlsLines, type LookAheadTable, type TextContext,
} from "./text";

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

const header = (labels: string[], fill: string): Cell[] => labels.map((text) => ({ runs: [{ text, bold: true, color: COLOURS.white }], fill }));
const heading = (text: string, o: { size?: number; align?: "left" | "center"; underline?: boolean; colour?: string; spaceBefore?: number } = {}): Block => ({
  kind: "heading",
  runs: [{ text, bold: true, ...(o.underline ? { underline: true } : {}), ...(o.colour ? { color: o.colour } : {}) }],
  size: o.size ?? 12,
  ...(o.align ? { align: o.align } : {}),
  ...(o.spaceBefore ? { spaceBefore: o.spaceBefore } : {}),
});

function dateRuns(r: { date: FriendlyDateParts; flag: boolean; row: ReportRow }, colour?: string): Run[] {
  const runs: Run[] = [{ text: r.date.text, ...(colour ? { color: colour } : {}) }];
  if (r.date.pending) runs.push({ text: `${r.date.text ? " " : ""}${r.date.pending}`, bold: true, color: COLOURS.pending });
  return r.flag ? [...runs, ...flagRuns(r.row)] : runs;
}

function eventsTable(c: LookAheadContext, day: string, rows: LaRow[]): Block {
  return {
    kind: "table",
    widths: [62, 36, "*", 50, 58],
    header: header([shortDay(day), "Lead", "Activity/Details", "RLS", "CC ID#"], COLOURS.events),
    rows: rows.map((r, i) => {
      const fill = r.issue ? COLOURS.issues : i % 2 === 0 ? COLOURS.zebra : undefined;
      const f = fill ? { fill } : {};
      return [
        { runs: dateRuns(r, COLOURS.white), fill: COLOURS.events },
        { runs: [{ text: leadOf(r.row, c.rules) }], align: "center", ...f },
        { runs: r.text, ...f },
        { runs: [{ text: r.rls.join("\n") }], align: "center", ...f },
        { runs: minIdRuns(r.row, c), align: "center", ...f },
      ];
    }),
  };
}

function listTable(c: LookAheadContext, first: string, rows: LaRow[], dateFill: string, issues: boolean): Block {
  return {
    kind: "table",
    widths: [62, 58, "*", 52, 46],
    header: header([first, "CC ID#", "Activity/Details", "Category", "Rls"], COLOURS.listHeader),
    rows: rows.map((r) => {
      const purple = issues || r.issue ? { fill: COLOURS.issues } : {};
      return [
        { runs: dateRuns(r), fill: dateFill },
        { runs: minIdRuns(r.row, c), align: "center", ...(r.issue && !issues ? purple : {}) },
        { runs: r.text, ...purple },
        { runs: [{ text: r.category }], align: "center", ...purple },
        { runs: [{ text: r.rls.join("\n") }], align: "center", ...(r.issue && !issues ? purple : {}) },
      ];
    }),
  };
}

/** Awareness Dates' or the Long Term Outlook's rows (ActivityHandler.ashx.cs:808-838): list order, no day split; HQ's Outlook only those marked for it. */
function laterRows(c: LookAheadContext, placed: readonly Placed[], which: "awareness" | "outlook"): ReportRow[] {
  return placed.filter((p) => p.place === which && (which === "awareness" || !c.isHq || p.row.longTermOutlook)).map((p) => p.row);
}

function laterTable(c: LookAheadContext, rows: ReportRow[], which: "awareness" | "outlook"): Block {
  const outlook = which === "outlook";
  return {
    kind: "table",
    widths: [62, "*", 72],
    header: header(["Date", outlook ? "Activity/Details" : "Name", "CC ID#"], outlook ? COLOURS.outlookHeader : COLOURS.listHeader),
    rows: rows.map((row) => [
      { runs: dateRuns({ row, flag: true, date: friendlyDateParts(row, { timeZone: c.rules.timeZone, today: c.today, weekday: false }) }), fill: outlook ? COLOURS.outlook : COLOURS.awareness },
      { runs: lookAheadText(row, c.rules, { titleOnly: !outlook }) },
      { runs: minIdRuns(row, c), align: "center" },
    ]),
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
 * Look Ahead (§10.3). Six sections: legacy's "Consultations and Dialogues" is dropped (carry-forward § 5g).
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
  const legend = [
    { colour: COLOURS.events, runs: [{ text: "Events, Speeches and Releases", bold: true }, { text: " (Inside Government)" }] },
    { colour: COLOURS.issues, runs: [{ text: "Issues and Reports", bold: true }] },
    { colour: COLOURS.news, runs: [{ text: "In the News", bold: true }, { text: " (Outside Government)" }] },
    { colour: COLOURS.awareness, runs: [{ text: "Awareness Dates", bold: true }] },
    ...(range.includeOutlook ? [{ colour: COLOURS.outlook, runs: [{ text: "Long Term Outlook", bold: true }] }] : []),
  ];
  const blocks: Block[] = [
    { kind: "banner", organization: c.rules.reports.cover.organization, lines: [...c.rules.reports.cover.lines] },
    heading(title, { size: 14, spaceBefore: 24 }),
    { kind: "heading", runs: [{ text: "Contents:", color: "#808080" }], size: 11, spaceBefore: 6 },
    { kind: "legend", items: legend },
    { kind: "pageBreak" },
    heading("Inside Government", { size: 14, underline: true }),
  ];
  // ActivityHandler.ashx.cs:707-731: HQ breaks after every day but a Saturday; everyone, after the last day. Legacy adds the
  // day's rows (plus 2 for its headings) and then tests the total plus them again against 16, counting the day twice: a
  // Saturday breaks from 7 rows, (7 + 2) x 2 > 16, whatever came before it. Kept as legacy had it.
  let sinceBreak = 0;
  days.forEach((day, i) => {
    const rows = sectionRows(c, events[i]!, { table: "events", day, detailed: o.detailed });
    if (rows.length === 0) blocks.push(heading(`No Activities for ${longDay(day)}`, { size: 14, align: "center", colour: COLOURS.heading, spaceBefore: 12 }));
    else blocks.push(heading(longDay(day), { size: 14, align: "center", colour: COLOURS.heading, spaceBefore: 12 }), heading("Events, Speeches & Releases", { colour: COLOURS.heading }), eventsTable(c, day, rows));
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
    blocks.push(heading("ISSUES AND REPORTS", { colour: COLOURS.heading }), listTable(c, "Date", issues, COLOURS.issuesDate, true));
    // IssuesSubreport's PageBreakAtEnd is IsAppOwner.
    if (c.isHq) blocks.push({ kind: "pageBreak" });
  }
  blocks.push(heading("Outside Government", { size: 14, underline: true }));
  days.forEach((day, i) => {
    const rows = sectionRows(c, news[i]!, { table: "news", day, detailed: o.detailed });
    if (rows.length) blocks.push(heading("In the News", { colour: COLOURS.heading, spaceBefore: 8 }), listTable(c, shortDay(day), rows, COLOURS.news, false));
  });
  // RectangleAwarenessPageBreak breaks for HQ only; not when nothing follows it, which would end the PDF on a blank page.
  if (c.isHq && (awareness.length || outlook.length)) blocks.push({ kind: "pageBreak" });
  if (awareness.length) blocks.push(heading("AWARENESS DATES", { colour: COLOURS.heading }), laterTable(c, awareness, "awareness"));
  if (outlook.length) {
    // The Awareness subreport's PageBreakAtEnd is IncludeLTOutlook.
    if (awareness.length) blocks.push({ kind: "pageBreak" });
    blocks.push(heading("LONG TERM OUTLOOK", { colour: COLOURS.heading, spaceBefore: 12 }), laterTable(c, outlook, "outlook"));
  }
  return {
    page: "letter-portrait",
    title: o.detailed ? "Exec Look Ahead" : "Look Ahead",
    firstPage: { header: { right: [{ text: "DRAFT ONLY - NOT FOR CIRCULATION\nInformation is confidential and subject to change" }] }, footer: null },
    header: { left: [{ text: c.rules.reportBanner.province, bold: true, size: 11 }], right: [{ text: c.rules.reportBanner.confidentiality, color: COLOURS.draft }] },
    footer: {
      left: [{ text: updatedLong(c.now, c.rules.timeZone), size: 7 }],
      center: [{ text: '"CHANGED" applies to major detail or date changes only (not time switches)', size: 7 }],
      pageNumbers: true,
    },
    blocks,
  };
}
