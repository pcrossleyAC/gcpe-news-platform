import { isSafeUrl } from "@gcpe/http-kit";
import type { GovernmentTermDto, GovernmentTermsDto } from "./dto";
import type { TermOf } from "./rebuild-set";

/** UTC date arithmetic on `YYYY-MM-DD`. */
export function addDays(isoDate: string, n: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The first BC day after the term, or null for the open (current) term. */
export const termEndExclusive = (t: Pick<GovernmentTermDto, "endDate">): string | null => (t.endDate === null ? null : addDays(t.endDate, 1));

/** The payload's newest term (the only one without an end date) is the current one. */
export const isCurrentTerm = (t: Pick<GovernmentTermDto, "endDate">): boolean => t.endDate === null;

/** The term's legacy archive link, only when it's an absolute http(s) URL. */
export const legacyHref = (t: Pick<GovernmentTermDto, "legacyArchiveUrl">): string | null =>
  t.legacyArchiveUrl && isSafeUrl(t.legacyArchiveUrl, { relative: false }) ? t.legacyArchiveUrl : null;

/**
 * Spec §3: a term with no posts on this site and a legacy archive link (the pre-2012 collections)
 * links out and gets no page of its own. The current term always has a page (its first morning
 * shows the empty copy, and the `current` alias must exist).
 */
export const isLegacyOnly = (t: GovernmentTermDto, count: number): boolean => count === 0 && !isCurrentTerm(t) && legacyHref(t) !== null;

/** Spec N1: a BC day belongs to the term with the latest start on or before it. */
export function termOfDay(dto: GovernmentTermsDto | null): TermOf {
  const terms = [...(dto?.terms ?? [])].sort((a, b) => (a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : 0));
  return (day) => {
    const t = terms.find((x) => x.startDate <= day);
    return t ? { slug: t.slug, isCurrent: t.slug === dto?.currentSlug } : null;
  };
}
