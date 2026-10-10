import { and, desc, eq, gte, inArray, lt, notInArray, sql, type SQL } from "drizzle-orm";
import {
  FEED_ACTIONS, FEED_LATEST_COUNT, FEED_MAX_ITEMS, LOOK_AHEAD_HISTORY_FIELDS, type FeedAction, type FeedItem, type FeedPage, type FeedQuery,
} from "@gcpe/calendar-contract";
import type { CalendarActor } from "./actor";
import { ActivityNotFoundError } from "./activities/errors";
import { inReadSnapshot } from "./activities/store";
import { activities, activityChangeFields, activityChanges, orgs } from "./db/schema";
import type { ApiDeps } from "./http/routes";
import { executiveSummaryShown, scopeOf, type ListScope } from "./list/query";
import { addDays, bcMidnight } from "./time";
import { visibleSql } from "./visibility";

/** An `updated` entry whose every field (one at least) is a Look Ahead field. */
const onlyLookAheadFields = sql`(${activityChanges.action} = 'updated'
  AND EXISTS (SELECT 1 FROM ${activityChangeFields} WHERE ${activityChangeFields.changeId} = ${activityChanges.id})
  AND NOT EXISTS (SELECT 1 FROM ${activityChangeFields} WHERE ${activityChangeFields.changeId} = ${activityChanges.id} AND ${notInArray(activityChangeFields.fieldKey, [...LOOK_AHEAD_HISTORY_FIELDS])}))`;

/**
 * View changes leaves out an entry that recorded only Look Ahead fields for whoever doesn't see
 * that fieldset on the activity (activities/view.ts); so does the feed, or "changed activity" would
 * say that HQ touched them. executiveSummaryShown is that fieldset's rule as SQL.
 */
function lookAheadRule(scope: ListScope): SQL {
  const shown = executiveSummaryShown(scope);
  return shown === null ? sql`NOT ${onlyLookAheadFields}` : sql`(NOT ${onlyLookAheadFields} OR ${shown})`;
}

/** Whole BC days of the entry's time, both ends included (GetCorpCalendarUpdatesBetweenDates). */
function viewWhere(scope: ListScope, q: FeedQuery, activityId: number | null): SQL[] {
  const day = (d: string) => bcMidnight(d, scope.rules.timeZone);
  if (activityId !== null) return [eq(activityChanges.activityId, activityId)];
  switch (q.mode) {
    case "latest":
    case "activity":
      return [];
    case "today":
      return [gte(activityChanges.at, day(scope.today)), lt(activityChanges.at, day(addDays(scope.today, 1)))];
    case "range": {
      const out: SQL[] = [];
      if (q.from) out.push(gte(activityChanges.at, day(q.from)));
      if (q.to) out.push(lt(activityChanges.at, day(addDays(q.to, 1))));
      if (q.type) out.push(eq(activityChanges.action, q.type));
      return out;
    }
  }
}

/**
 * The updates feed (spec addendum §9.1): history entries written by the Calendar, of activities the
 * actor can see as they stand now, newest first. Imported legacy log entries are not in it (C135).
 */
export function readFeed(deps: ApiDeps, actor: CalendarActor, q: FeedQuery): Promise<FeedPage> {
  return inReadSnapshot(deps.db, async (tx) => {
    const scope = await scopeOf(tx, deps, actor);
    const activityId = q.mode === "activity" ? q.activity : null;
    if (activityId !== null) {
      // One activity's updates are a read of that activity: not visible is not found (spec addendum §6).
      const [seen] = await tx.select({ id: activities.id }).from(activities).where(and(eq(activities.id, activityId), visibleSql(actor)));
      if (!seen) throw new ActivityNotFoundError();
    }
    const rows = await tx
      .select({
        id: activityChanges.id,
        at: activityChanges.at,
        action: activityChanges.action,
        actorName: activityChanges.actorName,
        activityId: activities.id,
        ministryAbbreviation: sql<string | null>`(SELECT ${orgs.abbreviation} FROM ${orgs} WHERE ${orgs.key} = ${activities.contactMinistryKey})`,
        title: activities.title,
        details: activities.details,
        startAt: activities.startAt,
        endAt: activities.endAt,
        isAllDay: activities.isAllDay,
        isConfirmed: activities.isConfirmed,
        potentialDates: activities.potentialDates,
        deletedAt: activities.deletedAt,
      })
      .from(activityChanges)
      .innerJoin(activities, eq(activities.id, activityChanges.activityId))
      .where(
        and(
          eq(activityChanges.source, "calendar"),
          inArray(activityChanges.action, [...FEED_ACTIONS]),
          visibleSql(actor),
          lookAheadRule(scope),
          ...viewWhere(scope, q, activityId),
        ),
      )
      .orderBy(desc(activityChanges.at), desc(activityChanges.id))
      .limit(q.mode === "latest" ? FEED_LATEST_COUNT : FEED_MAX_ITEMS + 1);
    return {
      mode: activityId !== null ? "activity" : q.mode,
      activityId,
      items: rows.slice(0, FEED_MAX_ITEMS).map(
        (r): FeedItem => ({
          id: r.id,
          at: r.at.toISOString(),
          action: r.action as FeedAction,
          actorName: r.actorName,
          activityId: r.activityId,
          ministryAbbreviation: r.ministryAbbreviation,
          title: r.title,
          details: r.details,
          startAt: r.startAt?.toISOString() ?? null,
          endAt: r.endAt?.toISOString() ?? null,
          isAllDay: r.isAllDay,
          isConfirmed: r.isConfirmed,
          potentialDates: r.potentialDates,
          isDeleted: r.deletedAt !== null,
        }),
      ),
      truncated: rows.length > FEED_MAX_ITEMS,
    };
  });
}
