import type { governmentTerms } from "./db/schema";

export type TermStatus = "past" | "current" | "scheduled" | "undated";

export interface TermSpan {
  id: string;
  slug: string;
  label: string | null;
  startDate: string | null;
  endDate: string | null;
  status: TermStatus;
  legacyArchiveUrl: string | null;
  legacyId: string | null;
}

/** The public shape of one term (the `government_terms.published` payload's `terms` entries; Task 2 adds the zod schema). */
export interface PublicTerm {
  slug: string;
  label: string | null;
  startDate: string;
  endDate: string | null;
  legacyArchiveUrl: string | null;
}

/** UTC date arithmetic on `YYYY-MM-DD`. */
export function addDays(isoDate: string, n: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * The one place term ranges are computed. Dated rows come first, oldest to newest, then undated rows.
 * `endDate` is the next dated row's start minus one day, scheduled rows included (the Hub view);
 * `publicTerms` hides scheduled terms and reopens the newest public one.
 * `today` is the BC calendar date: the latest start on or before it is current.
 */
export function termSpans(rows: (typeof governmentTerms.$inferSelect)[], today: string): TermSpan[] {
  const dated = rows.filter((r) => r.startDate !== null).sort((a, b) => (a.startDate! < b.startDate! ? -1 : a.startDate! > b.startDate! ? 1 : 0));
  const undated = rows.filter((r) => r.startDate === null);
  let currentIdx = -1;
  dated.forEach((r, i) => {
    if (r.startDate! <= today) currentIdx = i;
  });
  const span = (r: (typeof dated)[number], endDate: string | null, status: TermStatus): TermSpan => ({
    id: r.id,
    slug: r.name,
    label: r.label,
    startDate: r.startDate,
    endDate,
    status,
    legacyArchiveUrl: r.legacyArchiveUrl,
    legacyId: r.legacyId,
  });
  return [
    ...dated.map((r, i) => {
      const next = dated[i + 1];
      const status: TermStatus = i < currentIdx ? "past" : i === currentIdx ? "current" : "scheduled";
      return span(r, next ? addDays(next.startDate!, -1) : null, status);
    }),
    ...undated.map((r) => span(r, null, "undated")),
  ];
}

/** Only past and current terms, newest first; the newest has no end date (scheduled terms must not close it). */
export function publicTerms(spans: TermSpan[]): PublicTerm[] {
  return spans
    .filter((s) => s.status === "past" || s.status === "current")
    .reverse()
    .map((s, i) => ({
      slug: s.slug,
      label: s.label,
      startDate: s.startDate!,
      endDate: i === 0 ? null : s.endDate,
      legacyArchiveUrl: s.legacyArchiveUrl,
    }));
}
