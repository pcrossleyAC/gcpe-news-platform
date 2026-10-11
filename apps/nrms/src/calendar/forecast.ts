import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { hasCategoryStartingWith, visible, type Viewer } from "@gcpe/calendar-contract";
import type { ForecastItem, ForecastPage, ForecastQuery } from "@gcpe/nrms-contract";
import { calendarActivities, newsReleases, organizations, type CalendarActivityRow, type NewsReleaseRow } from "../db/schema";
import { listItems } from "../releases/queries";
import { factsOf, locationOf } from "./lookup";

export const FORECAST_PAGE_SIZE = 25;
/** At most this many releases, and this many activities, are read from now on: years of legacy's volume. */
export const FORECAST_CANDIDATE_LIMIT = 5000;

export interface ForecastOptions {
  /** The tenant's `calendar.forecastCategoryPrefix`; null lists releases only. */
  prefix: string | null;
  nowMs: number;
}

type Entry = { kind: "release"; at: Date; row: NewsReleaseRow } | { kind: "activity"; at: Date; row: CalendarActivityRow };

/** Legacy's order (ReleasesModel.cs:229): by time; at the same time a release before an activity, then by id. */
function byTime(x: Entry, y: Entry): number {
  const t = x.at.getTime() - y.at.getTime();
  if (t !== 0) return t;
  if (x.kind !== y.kind) return x.kind === "release" ? -1 : 1;
  return String(x.row.id).localeCompare(String(y.row.id), "en", { numeric: true });
}

/**
 * The Forecast tab (spec addendum §11, ReleasesModel.cs:144-230), evaluated at read time against
 * the database clock. Releases: every non-deleted one planned or scheduled from now on.
 * Activities: confirmed, not confidential or deleted, starting from now on, with a category
 * starting with the tenant's prefix, not linked to one of those releases, and visible to `viewer`
 * in the Calendar (spec addendum §6). Each is placed at its release time, or else its start.
 */
export async function forecast(db: DbOrTx, viewer: Viewer | null, q: ForecastQuery, o: ForecastOptions): Promise<ForecastPage> {
  const releases = await db
    .select()
    .from(newsReleases)
    .where(and(ne(newsReleases.status, "deleted"), sql`${newsReleases.publishAt} >= now()`))
    .orderBy(asc(newsReleases.publishAt), asc(newsReleases.id))
    .limit(FORECAST_CANDIDATE_LIMIT);
  const linked = new Set(releases.flatMap((r) => (r.activityId === null ? [] : [r.activityId])));
  const showActivities = viewer !== null && o.prefix !== null;
  const candidates = showActivities
    ? await db
        .select()
        .from(calendarActivities)
        .where(and(eq(calendarActivities.isConfidential, false), eq(calendarActivities.isDeleted, false), eq(calendarActivities.isConfirmed, true), sql`${calendarActivities.startAt} >= now()`))
        .orderBy(sql`coalesce(${calendarActivities.nrAt}, ${calendarActivities.startAt})`, asc(calendarActivities.id))
        .limit(FORECAST_CANDIDATE_LIMIT)
    : [];
  const activities = candidates.filter((a) => !linked.has(a.id) && hasCategoryStartingWith(a.categoryNames, o.prefix!) && visible(viewer!, factsOf(a)));
  const all: Entry[] = [
    ...releases.map((row): Entry => ({ kind: "release", at: row.publishAt!, row })),
    ...activities.map((row): Entry => ({ kind: "activity", at: row.nrAt ?? row.startAt!, row })),
  ].sort(byTime);

  const pageEntries = all.slice((q.page - 1) * FORECAST_PAGE_SIZE, q.page * FORECAST_PAGE_SIZE);
  const releaseItems = new Map((await listItems(db, pageEntries.flatMap((e) => (e.kind === "release" ? [e.row] : [])), o.nowMs)).map((i) => [i.id, i]));
  const ministryKeys = [...new Set(pageEntries.flatMap((e) => (e.kind === "activity" && e.row.contactMinistryKey ? [e.row.contactMinistryKey.toLowerCase()] : [])))];
  const names = new Map(
    ministryKeys.length ? (await db.select({ key: organizations.key, name: organizations.displayName }).from(organizations).where(inArray(organizations.key, ministryKeys))).map((m) => [m.key, m.name]) : [],
  );
  const items = pageEntries.map((e): ForecastItem => {
    const at = e.at.toISOString();
    if (e.kind === "release") return { kind: "release", at, release: releaseItems.get(e.row.id)! };
    const a = e.row;
    return {
      kind: "activity", at,
      activity: {
        activityId: a.id, title: a.title ?? "", details: a.details ?? "", ministryName: a.contactMinistryKey ? (names.get(a.contactMinistryKey.toLowerCase()) ?? null) : null,
        categoryNames: a.categoryNames, location: locationOf(a.cityName),
      },
    };
  });
  return { items, total: all.length, page: q.page, pageSize: FORECAST_PAGE_SIZE, calendarActivities: showActivities };
}
