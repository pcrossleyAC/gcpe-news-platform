import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import {
  bcDateSchema, DEFAULT_HIDDEN_COLUMNS, listFilterSchema, type ActivityStatus, type HideableColumn, type ListDisplay, type ListFilter,
} from "@gcpe/calendar-contract";
import { categories, governmentRepresentatives, initiatives, keywords, nrDistributions, premierRequested, savedFilters } from "../db/schema";
import { SAVED_FILTER_LIMIT } from "./saved-filters";

/** A legacy calendar.ActivityFilter row, as the importer reads it. */
export interface LegacySavedFilterRow {
  id: number;
  createdBy: number | null;
  name: string | null;
  queryString: string | null;
  sortOrder: number | null;
  isActive: boolean | null;
}
/** How legacy ids become Core's: 5i supplies these from Core's tables. */
export interface LegacyFilterResolver {
  ministryKeyOf(legacyGuid: string): string | null;
  userIdOf(legacyUserId: number): string | null;
}
export interface DroppedParam {
  key: string;
  value: string;
  reason: string;
}
export interface ConvertedFilter {
  filter: ListFilter;
  dropped: DroppedParam[];
}

/** The 91 stale keys carry this prefix (spec addendum §12.1); legacy's SetFilter stripped it (Default.aspx:429). */
const STALE_PREFIX = "ActivityListProvider.aspx?";
const NOT_APPLIED = "legacy never applied it to a saved query";
/** Legacy StatusId: 1 Changed, 2 Reviewed, 7 New (spec addendum §5.2). */
const LEGACY_STATUS: Record<string, ActivityStatus> = { "1": "changed", "2": "reviewed", "7": "new" };
const INT4_MAX = 2_147_483_647;

const intOf = (s: string): number | null => {
  if (!/^-?\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return Math.abs(n) <= INT4_MAX ? n : null;
};
const boolOf = (s: string): boolean | null => (/^true$/i.test(s) ? true : /^false$/i.test(s) ? false : null);
/** jQuery UI's datepicker wrote M/D/YYYY; accept ISO too. */
function dateOf(s: string): string | null {
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  const iso = us ? `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}` : s;
  return bcDateSchema.safeParse(iso).success ? iso : null;
}
const decoded = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * One legacy query string as the list's filter. It applies what legacy's SetFilter applied
 * (Default.aspx:426-488); display, This day only and the Look Ahead setting were saved but never
 * applied, so they are dropped. Anything unreadable is dropped with a reason; the rest is kept.
 */
export function convertLegacyQuery(queryString: string, resolve: LegacyFilterResolver): ConvertedFilter {
  const stale = queryString.startsWith(STALE_PREFIX);
  const body = stale ? queryString.slice(STALE_PREFIX.length) : queryString;
  // Current keys join with "|" (Default.aspx's GetQuery for a post); the stale URL form joined with "&".
  const parts = body.split(stale && !body.includes("|") ? "&" : "|").filter(Boolean);
  const f: Record<string, unknown> = {};
  const dropped: DroppedParam[] = [];
  const drop = (key: string, value: string, reason: string) => dropped.push({ key, value, reason });
  const idInto = (field: string, key: string, value: string, what: string) => {
    const n = intOf(value);
    if (n !== null && n > 0) f[field] = n;
    else drop(key, value, `not a ${what} id`);
  };
  for (const part of parts) {
    const at = part.indexOf("=");
    const key = at < 0 ? part : part.slice(0, at);
    // Everything after the first "=": legacy's split("=")[1] cut a value at a second one.
    const value = stale ? decoded(at < 0 ? "" : part.slice(at + 1)) : at < 0 ? "" : part.slice(at + 1);
    if (value === "" || value === "*") continue;
    switch (key) {
      case "status": {
        const s = LEGACY_STATUS[value];
        if (s) f.status = s;
        else drop(key, value, "unknown status");
        break;
      }
      case "category": {
        const n = intOf(value);
        if (n !== null && n > 0) f.categoryId = n;
        else drop(key, value, n !== null && n < 0 ? "an exclusion, which a saved query can't hold" : "not a category id");
        break;
      }
      case "ministry": {
        const k = resolve.ministryKeyOf(value);
        if (k !== null) f.ministryKey = k;
        else drop(key, value, "no Core ministry for this id");
        break;
      }
      case "contact": {
        const n = intOf(value);
        const u = n === null ? null : resolve.userIdOf(n);
        if (u !== null) f.commContactUserId = u;
        else drop(key, value, "no Core user for this legacy user");
        break;
      }
      case "representative":
        idInto("representativeId", key, value, "representative");
        break;
      case "initiative":
        idInto("initiativeId", key, value, "initiative");
        break;
      case "premierRequested":
        idInto("premierRequestedId", key, value, "Premier requested");
        break;
      case "distribution":
        idInto("distributionId", key, value, "distribution");
        break;
      case "keywords": {
        const ids = value.split("~").map(intOf);
        const good = [...new Set(ids.filter((n): n is number => n !== null && n > 0))];
        if (good.length) f.keywordIds = good.slice(0, 50);
        if (good.length !== ids.length) drop(key, value, "a keyword id that isn't a number");
        else if (good.length > 50) drop(key, value, "more than 50 HQ Tags; the first 50 kept");
        break;
      }
      case "isissue":
      case "dateConfirmed": {
        const b = boolOf(value);
        if (b !== null) f[key === "isissue" ? "isIssue" : "dateConfirmed"] = b;
        else drop(key, value, "not true or false");
        break;
      }
      case "datefrom":
      case "dateto": {
        const d = dateOf(value);
        if (d !== null) f[key === "datefrom" ? "from" : "to"] = d;
        else drop(key, value, "not a date");
        break;
      }
      case "quickSearch": {
        const t = value.replace(/\u0000/g, "").trim();
        if (t.length <= 200) f.quickSearch = t;
        else drop(key, value, "longer than 200 characters");
        break;
      }
      case "display":
      case "thisdayonly":
      case "lookahead":
        drop(key, value, NOT_APPLIED);
        break;
      default:
        drop(key, value, "unknown parameter");
    }
  }
  if (typeof f.from === "string" && typeof f.to === "string" && f.from > f.to) {
    drop("dateto", f.to, "before the From date");
    delete f.to;
  }
  return { filter: listFilterSchema.parse(f), dropped };
}

export interface SavedFilterMigrationReport {
  read: number;
  migrated: number;
  skippedInactive: number;
  skippedNoOwner: { id: number; legacyOwner: number | null }[];
  strippedPrefix: number;
  dropped: ({ id: number } & DroppedParam)[];
  /** An owner whose migrated queries put them over the per-owner cap (saved-filters.ts); never fails the run. */
  overCap?: { ownerId: string; count: number }[];
}

/** Ids in the filter that no Calendar lookup holds are dropped too, so a saved query never names a missing row. */
const LOOKUP_FIELDS = [
  { field: "categoryId", key: "category", what: "category" },
  { field: "representativeId", key: "representative", what: "government representative" },
  { field: "initiativeId", key: "initiative", what: "initiative" },
  { field: "premierRequestedId", key: "premierRequested", what: "Premier requested value" },
  { field: "distributionId", key: "distribution", what: "NR distribution" },
] as const;
type LookupField = (typeof LOOKUP_FIELDS)[number]["field"];
const idSet = async (q: Promise<{ id: number }[]>) => new Set((await q).map((r) => r.id));

/**
 * Writes the active legacy saved queries whose owner is a Core user, keeping legacy ids; a re-run
 * updates them in place. 5i re-bases the saved_filters identity afterwards.
 */
export async function migrateLegacySavedFilters(db: Db, rows: LegacySavedFilterRow[], resolve: LegacyFilterResolver): Promise<SavedFilterMigrationReport> {
  const report: SavedFilterMigrationReport = { read: rows.length, migrated: 0, skippedInactive: 0, skippedNoOwner: [], strippedPrefix: 0, dropped: [] };
  const known: Record<LookupField, Set<number>> = {
    categoryId: await idSet(db.select({ id: categories.id }).from(categories)),
    representativeId: await idSet(db.select({ id: governmentRepresentatives.id }).from(governmentRepresentatives)),
    initiativeId: await idSet(db.select({ id: initiatives.id }).from(initiatives)),
    premierRequestedId: await idSet(db.select({ id: premierRequested.id }).from(premierRequested)),
    distributionId: await idSet(db.select({ id: nrDistributions.id }).from(nrDistributions)),
  };
  const knownKeywords = await idSet(db.select({ id: keywords.id }).from(keywords));
  const touchedOwners = new Set<string>();
  for (const row of rows) {
    if (row.isActive !== true) {
      report.skippedInactive++;
      continue;
    }
    const ownerId = row.createdBy === null ? null : resolve.userIdOf(row.createdBy);
    if (!ownerId) {
      report.skippedNoOwner.push({ id: row.id, legacyOwner: row.createdBy });
      continue;
    }
    const qs = row.queryString ?? "";
    if (qs.startsWith(STALE_PREFIX)) report.strippedPrefix++;
    const { filter, dropped } = convertLegacyQuery(qs, resolve);
    for (const l of LOOKUP_FIELDS) {
      const v = filter[l.field];
      if (v !== null && !known[l.field].has(v)) {
        dropped.push({ key: l.key, value: String(v), reason: `no such ${l.what} in the Calendar` });
        filter[l.field] = null;
      }
    }
    const missing = filter.keywordIds.filter((k) => !knownKeywords.has(k));
    if (missing.length) {
      dropped.push({ key: "keywords", value: missing.join("~"), reason: "no such HQ Tag in the Calendar" });
      filter.keywordIds = filter.keywordIds.filter((k) => knownKeywords.has(k));
    }
    report.dropped.push(...dropped.map((d) => ({ id: row.id, ...d })));
    const values = { ownerId, name: (row.name ?? "").trim().slice(0, 200) || "My Query", filter, sortOrder: row.sortOrder ?? 0, isActive: true };
    await db.insert(savedFilters).values({ id: row.id, ...values }).onConflictDoUpdate({ target: savedFilters.id, set: values });
    report.migrated++;
    touchedOwners.add(ownerId);
  }
  if (touchedOwners.size) {
    const counts = await db
      .select({ ownerId: savedFilters.ownerId, n: sql<number>`count(*)`.mapWith(Number) })
      .from(savedFilters)
      .where(and(eq(savedFilters.isActive, true), inArray(savedFilters.ownerId, [...touchedOwners])))
      .groupBy(savedFilters.ownerId);
    const over = counts.filter((c) => c.n > SAVED_FILTER_LIMIT).map((c) => ({ ownerId: c.ownerId, count: c.n }));
    if (over.length) report.overCap = over;
  }
  return report;
}

/** Legacy HiddenColumns held grid column indexes (UCFlexiGrid.ascx.cs's ColumnModel); null meant HiddenByDefault. */
const LEGACY_COLUMNS: Record<string, HideableColumn> = {
  "1": "keywords", "2": "ministry", "3": "status", "4": "dateTime", "5": "title", "6": "categories", "7": "commMaterials",
  "8": "premier", "9": "leadOrg", "10": "translations", "11": "city", "12": "commContact", "13": "governmentRep",
};
export function legacyHiddenColumns(csv: string | null): HideableColumn[] {
  if (csv === null) return [...DEFAULT_HIDDEN_COLUMNS];
  const mapped = csv.split(",").map((c) => LEGACY_COLUMNS[c.trim()]).filter((c): c is HideableColumn => c !== undefined);
  return [...new Set(mapped)].sort();
}

/** Legacy FilterDisplayValue (Default.aspx:608-613): 3 Show All, 2 My Ministries, 4 My Activities, 10 My Watchlist. */
export function legacyDisplay(value: number | null): ListDisplay {
  return value === 2 ? "my_ministries" : value === 4 ? "my_activities" : value === 10 ? "my_watchlist" : "all";
}
