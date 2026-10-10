import { and, asc, eq, sql } from "drizzle-orm";
import type { CalendarRangeView, ListQuery } from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { inReadSnapshot } from "../activities/store";
import { activities, orgs } from "../db/schema";
import type { ApiDeps } from "../http/routes";
import { addDays, bcMidnight } from "../time";
import { listWhere, scopeOf } from "./query";

export const CALENDAR_ITEM_LIMIT = 1000;

/** The month or week view (spec addendum §8.1): the query's filters, the view's dates. */
export function calendarRange(deps: ApiDeps, actor: CalendarActor, q: ListQuery, start: string, end: string): Promise<CalendarRangeView> {
  return inReadSnapshot(deps.db, async (tx) => {
    const scope = await scopeOf(tx, deps, actor);
    const tz = deps.rules.timeZone;
    const inView: ListQuery = { ...q, filter: { ...q.filter, from: start, to: end, thisDayOnly: false } };
    const where = and(
      listWhere(scope, inView),
      // Also for a corporate query or an id search, which don't read the filter's dates.
      sql`coalesce(${activities.endAt}, ${activities.startAt}) >= ${bcMidnight(start, tz)}`,
      sql`coalesce(${activities.startAt}, ${activities.endAt}) < ${bcMidnight(addDays(end, 1), tz)}`,
    );
    const rows = await tx
      .select({
        id: activities.id, title: activities.title, startAt: activities.startAt, endAt: activities.endAt, isAllDay: activities.isAllDay,
        isConfirmed: activities.isConfirmed, isConfidential: activities.isConfidential, ministryAbbreviation: orgs.abbreviation,
      })
      .from(activities)
      .leftJoin(orgs, eq(orgs.key, activities.contactMinistryKey))
      .where(where)
      .orderBy(asc(activities.startAt), asc(activities.id))
      .limit(CALENDAR_ITEM_LIMIT + 1);
    return {
      truncated: rows.length > CALENDAR_ITEM_LIMIT,
      items: rows.slice(0, CALENDAR_ITEM_LIMIT).map((r) => ({ ...r, startAt: r.startAt?.toISOString() ?? null, endAt: r.endAt?.toISOString() ?? null })),
    };
  });
}
