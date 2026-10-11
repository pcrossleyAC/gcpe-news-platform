import type { ReportRow } from "../src/reports/data";

/** BC is UTC−7 from 2026-11-01: "2026-11-10", "09:00" is 16:00Z. */
export const bc = (date: string, time: string) => new Date(`${date}T${time}:00-07:00`).toISOString();

/** A report row with fictional values: a confirmed one-hour Health activity at 9 AM BC on 2026-11-10, In the News. */
export function reportRow(over: Partial<ReportRow> = {}): ReportRow {
  return {
    id: 20001, version: 1, ministryKey: "health", ministryAbbreviation: "HLTH", status: "reviewed", hqStatus: null, isDeleted: false,
    isWatched: false, watcherNames: [], isShared: false, hasRelease: false,
    createdAt: "2026-10-01T16:00:00.000Z", lastUpdatedAt: "2026-10-02T16:00:00.000Z", lastUpdatedByName: "Robin Staff",
    keywords: [], startAt: bc("2026-11-10", "09:00"), endAt: bc("2026-11-10", "10:00"), isAllDay: false, isConfirmed: true, potentialDates: "",
    title: "Sample activity", details: "Sample details", significance: "Sample significance", strategy: "", schedule: "",
    categories: ["Sample plain category"], isIssue: false, isConfidential: false, commMaterials: [], nrOrigins: [], nrDistribution: null,
    premierRequested: null, leadOrganization: "", translations: [], city: "Sample City", venue: "",
    commContact: { name: "Robin Staff", phone: "250-555-0101" }, governmentRepresentative: null, eventPlanner: null, needsReview: [],
    categoryIds: [32], hqSection: "in_the_news", longTermOutlook: false, executiveSummary: null, initiatives: [], nrAt: null,
    ...over,
  };
}

/** Each run's text joined: what a reader sees, styles aside. */
export const plain = (runs: { text: string }[]) => runs.map((r) => r.text).join("");

/**
 * A document's structure, for golden comparisons: "# heading", "---" for a page break, and each
 * table row as its CC ID# ("HLTH-20001"). Colours and fonts are the renderer's tests' business.
 */
export function outline(doc: { blocks: import("../src/reports/model").Block[] }): string[] {
  const out: string[] = [];
  for (const b of doc.blocks) {
    if (b.kind === "heading") out.push(`# ${plain(b.runs)}`);
    else if (b.kind === "pageBreak") out.push("---");
    else if (b.kind === "banner") out.push(`[banner] ${b.lines.join(" ")}`);
    else if (b.kind === "legend") out.push(`[legend] ${b.items.map((i) => plain(i.runs)).join(" | ")}`);
    else for (const row of b.rows) out.push(row.flatMap((cell) => plain(cell.runs).split("\n")).find((t) => /^[A-Z][A-Z0-9]*-\d+$/.test(t)) ?? "?");
  }
  return out;
}

/**
 * `n` fictional report rows starting across `days` days from `from`, the same for the same `seed`:
 * every Look Ahead section, multi-day and time-TBD rows, Awareness, the consultations ministry,
 * confidential and issue rows, flags, release codes, and an end with no start. In legacy's order.
 */
export function sampleRows(n: number, from: string, days: number, seed = 1): ReportRow[] {
  let s = seed >>> 0;
  const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const day = (offset: number) => new Date(Date.UTC(...(from.split("-").map(Number) as [number, number, number]).map((v, i) => (i === 1 ? v - 1 : i === 2 ? v + offset : v)) as [number, number, number])).toISOString().slice(0, 10);
  const sections = ["events_and_speeches", "in_the_news", "issues_and_reports", "not_on_la"] as const;
  const rows = Array.from({ length: n }, (_, i) => {
    const d = day(Math.floor(rand() * days));
    const span = rand() < 0.15 ? 1 + Math.floor(rand() * 8) : 0;
    const tbd = rand() < 0.1;
    const hh = 7 + Math.floor(rand() * 11);
    const start = tbd ? bc(d, "08:00") : bc(d, `${String(hh).padStart(2, "0")}:${pick(["00", "15", "30"])}`);
    const end = tbd ? bc(d, "18:00") : bc(span ? day(Math.round((Date.parse(d) - Date.parse(from)) / 86_400_000) + span) : d, `${String(hh + 1).padStart(2, "0")}:00`);
    const undated = rand() < 0.01;
    return reportRow({
      id: 30000 + i, title: `Sample generated ${i}`, hqSection: pick(sections), startAt: undated ? null : start, endAt: end,
      isConfirmed: !tbd && rand() < 0.8, isAllDay: !tbd && rand() < 0.05, isIssue: rand() < 0.1, isConfidential: rand() < 0.05,
      hqStatus: pick([null, null, null, "new", "changed"] as const), longTermOutlook: rand() < 0.3,
      categoryIds: rand() < 0.05 ? [2] : [32], categories: [pick(["Sample plain category", "Sample broadcast"])],
      ministryKey: rand() < 0.03 ? "consult" : "health", ministryAbbreviation: "HLTH",
      commMaterials: rand() < 0.3 ? [pick(["Sample news release", "Sample report", "Sample fact sheet"])] : [], nrOrigins: rand() < 0.2 ? ["Sample origin"] : [],
      nrAt: rand() < 0.2 ? bc(d, "10:30") : null, executiveSummary: rand() < 0.2 ? `**Sample summary ${i}** for HQ` : null,
    });
  });
  const key = (r: ReportRow) => [r.startAt ?? r.endAt ?? "", r.endAt ?? ""].join(" ");
  return rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id - b.id));
}
