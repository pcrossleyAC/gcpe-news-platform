import { isSafeUrl, safeErrorLabel } from "@gcpe/http-kit";
import type { GovernmentTermDto, GovernmentTermsDto } from "./dto";
import type { NewsApiClient } from "./news-api-client";
import type { TermOf } from "./rebuild-set";
import { TERM_SLUG } from "./site-paths";
import type { SiteStorage } from "./storage";

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

/**
 * NG-R18: the last applied terms snapshot, beside `.site-settings.json` and, like it, not served
 * (a leading dot) and kept across restarts. `degraded` records that the last fetch failed, so
 * the first good fetch after an outage can queue every term page again.
 */
export const GOVERNMENT_TERMS_PATH = ".government-terms.json";

interface PersistedTerms {
  dto: GovernmentTermsDto | null;
  degraded: boolean;
}

/** What this process last read or wrote at GOVERNMENT_TERMS_PATH, per output folder. */
const persistedJson = new WeakMap<SiteStorage, string>();

function parsePersisted(raw: string | null): PersistedTerms | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as { dto?: unknown; degraded?: unknown };
    const dto = v.dto as GovernmentTermsDto | null | undefined;
    if (dto !== null && (typeof dto !== "object" || dto === undefined || !Array.isArray(dto.terms))) return null;
    // Re-gated like a fetched payload: a slug only ever reaches a path through TERM_SLUG.
    const safe = dto ? { ...dto, terms: dto.terms.filter((t) => typeof t?.slug === "string" && TERM_SLUG.test(t.slug) && t.slug !== "current" && typeof t.startDate === "string") } : null;
    return { dto: safe, degraded: v.degraded === true };
  } catch {
    return null; // malformed/foreign content: nothing persisted
  }
}

async function readPersisted(storage: SiteStorage): Promise<PersistedTerms | null> {
  const known = persistedJson.get(storage);
  if (known !== undefined) return parsePersisted(known);
  const raw = await storage.read(GOVERNMENT_TERMS_PATH);
  if (raw !== null) persistedJson.set(storage, raw);
  return parsePersisted(raw);
}

async function writePersisted(storage: SiteStorage, state: PersistedTerms): Promise<void> {
  const json = JSON.stringify(state);
  if (persistedJson.get(storage) === json) return;
  await storage.write(GOVERNMENT_TERMS_PATH, json);
  persistedJson.set(storage, json);
}

export interface TermsView {
  /** The snapshot to use: fetched, else the last applied one, else null. */
  dto: GovernmentTermsDto | null;
  /** True when fetched this time (a 404, "nothing published yet", included). */
  fresh: boolean;
  /** Fetched after a failed fetch had been recorded: every term page needs rebuilding. */
  recovered: boolean;
}

/**
 * NG-R18, the same degrade as site settings (settings.ts currentSettings). Never rejects:
 * - fetched (or a 404): used and persisted as the last applied;
 * - failed (an error, a timeout, a malformed snapshot): the last applied snapshot, else none,
 *   with `fresh: false`. Logged once per outage, not once per caller.
 */
export async function currentTerms(newsApi: Pick<NewsApiClient, "governmentTerms">, storage: SiteStorage): Promise<TermsView> {
  let dto: GovernmentTermsDto | null;
  try {
    dto = await newsApi.governmentTerms();
  } catch (err) {
    const kept = await readPersisted(storage);
    if (!kept?.degraded) {
      console.error(`[public-site] government terms unavailable; ${kept?.dto ? "keeping the last applied terms" : "none applied yet, rendering without them"} ${safeErrorLabel(err)}`);
    }
    await writePersisted(storage, { dto: kept?.dto ?? null, degraded: true });
    return { dto: kept?.dto ?? null, fresh: false, recovered: false };
  }
  const recovered = (await readPersisted(storage))?.degraded === true;
  if (recovered) console.log("[public-site] government terms available again; rebuilding the term pages");
  await writePersisted(storage, { dto, degraded: false });
  return { dto, fresh: true, recovered };
}
