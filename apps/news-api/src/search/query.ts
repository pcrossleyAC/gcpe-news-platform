import { wallClockToInstant } from "@gcpe/config";
import { postKindSchema, type PostKind } from "@gcpe/events";

export const SEARCH_PAGE_SIZE = 20;
export const SEARCH_MAX_PAGE = 50;
export const SEARCH_MAX_QUERY_CHARS = 200;
export const SEARCH_MAX_KEY_CHARS = 100;
const MIN_YEAR = 1900;
const MAX_YEAR = 2199;

export interface SearchQuery {
  /** The search text; "" is a filter-only search (parseSearchQuery allows it only with a filter). */
  q: string;
  ministry?: string;
  sector?: string;
  type?: PostKind;
  /** The first instant of the `from` day in the tenant's time zone. */
  from?: Date;
  /** The first instant of the day after `to`, in the tenant's time zone. */
  toExclusive?: Date;
  page: number;
}

export type ParsedSearchQuery = { ok: true; query: SearchQuery } | { ok: false; parameter: string; message: string };

class Invalid {
  constructor(readonly parameter: string, readonly message: string) {}
}

function single(raw: Record<string, unknown>, name: string): string | undefined {
  const v = raw[name];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Invalid(name, `${name} must be given once`);
  if (v.includes("\u0000")) throw new Invalid(name, `${name} must not contain control characters`);
  return v;
}

function key(raw: Record<string, unknown>, name: string): string | undefined {
  const v = single(raw, name)?.trim();
  if (v === undefined) return undefined;
  if (v.length < 1 || v.length > SEARCH_MAX_KEY_CHARS) throw new Invalid(name, `${name} must be 1-${SEARCH_MAX_KEY_CHARS} characters`);
  return v;
}

/** The first instant of `ymd` (`YYYY-MM-DD`) plus `addDays`, in `timeZone`. */
function dayStart(raw: Record<string, unknown>, name: string, timeZone: string, addDays: number): Date | undefined {
  const v = single(raw, name);
  if (v === undefined) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const message = `${name} must be a date YYYY-MM-DD between ${MIN_YEAR} and ${MAX_YEAR}`;
  if (!m) throw new Invalid(name, message);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < MIN_YEAR || y > MAX_YEAR) throw new Invalid(name, message);
  const wall = new Date(Date.UTC(y, mo - 1, d));
  if (wall.getUTCFullYear() !== y || wall.getUTCMonth() !== mo - 1 || wall.getUTCDate() !== d) throw new Invalid(name, message);
  wall.setUTCDate(wall.getUTCDate() + addDays);
  return wallClockToInstant(wall, timeZone);
}

/** Whether the query narrows by anything besides its text. */
export function hasFilter(query: SearchQuery): boolean {
  return query.ministry !== undefined || query.sector !== undefined || query.type !== undefined || query.from !== undefined || query.toExclusive !== undefined;
}

/** Validates `GET /api/v2/search`'s query (spec §5.4). Messages state the rule, never the value. */
export function parseSearchQuery(raw: Record<string, unknown>, timeZone: string): ParsedSearchQuery {
  try {
    const q = single(raw, "q")?.trim() ?? "";
    const chars = Array.from(q).length;
    if (chars > SEARCH_MAX_QUERY_CHARS) throw new Invalid("q", `q must be 1-${SEARCH_MAX_QUERY_CHARS} characters`);

    const pageRaw = single(raw, "page");
    const page = pageRaw === undefined ? 1 : /^\d{1,3}$/.test(pageRaw) ? Number(pageRaw) : NaN;
    if (!(page >= 1 && page <= SEARCH_MAX_PAGE)) throw new Invalid("page", `page must be a whole number from 1 to ${SEARCH_MAX_PAGE}`);

    const typeRaw = single(raw, "type");
    const type = typeRaw === undefined ? undefined : postKindSchema.safeParse(typeRaw);
    if (type && !type.success) throw new Invalid("type", `type must be one of ${postKindSchema.options.join(", ")}`);

    const query: SearchQuery = { q, page };
    const ministry = key(raw, "ministry");
    const sector = key(raw, "sector");
    if (ministry !== undefined) query.ministry = ministry;
    if (sector !== undefined) query.sector = sector;
    if (type?.success) query.type = type.data;
    const from = dayStart(raw, "from", timeZone, 0);
    const toExclusive = dayStart(raw, "to", timeZone, 1);
    if (from && toExclusive && toExclusive <= from) throw new Invalid("to", "to must not be before from");
    if (from) query.from = from;
    if (toExclusive) query.toExclusive = toExclusive;
    // No text is a filter-only search (newest first, as legacy's Azure Search query without a
    // `search` term was) — but only with a filter; on its own it would list every post.
    if (chars < 1 && !hasFilter(query)) throw new Invalid("q", `q must be 1-${SEARCH_MAX_QUERY_CHARS} characters unless ministry, sector, type, from or to is given`);
    return { ok: true, query };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, parameter: e.parameter, message: e.message };
    throw e;
  }
}
