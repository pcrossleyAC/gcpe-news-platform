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
