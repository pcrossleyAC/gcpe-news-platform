import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { HqSection, ListQuery, ListRow } from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { inReadSnapshot } from "../activities/store";
import { can } from "../capabilities";
import { activities, activityCategories, activityInitiatives, activitySharedWith, initiatives } from "../db/schema";
import type { ApiDeps } from "../http/routes";
import { legacyReportOrder, listWhere, scopeOf, type ListScope } from "../list/query";
import { rowsOf } from "../list/rows";
import { dbNow } from "../time";
import type { VisibilityFacts } from "../visibility";

/** The most activities one report reads; more is refused with 422 before anything is built. */
export const REPORT_ACTIVITY_LIMIT = 5000;
export class ReportTooLargeError extends Error {
  override name = "ReportTooLargeError";
  constructor(what = "activities match") {
    super(`Too many ${what}: narrow the filter and run the report again`);
  }
}

/** A list row plus what only the reports read. */
export interface ReportRow extends ListRow {
  categoryIds: number[];
  /** Where the Look Ahead places it, for every viewer, as legacy (ActivityHandler.ashx.cs:899-1068). */
  hqSection: HqSection;
  longTermOutlook: boolean;
  /** The Executive Summary, only where the viewer sees the Look Ahead fieldset (spec addendum §6); null otherwise. */
  executiveSummary: string | null;
  /** HQ Initiatives' short names, by name. */
  initiatives: string[];
  /** NR date and time. */
  nrAt: string | null;
}

export interface ReportData {
  rows: ReportRow[];
  scope: ListScope;
  q: ListQuery;
  /** The database's now: the "Updated" time and every "updated X ago". */
  now: Date;
}

async function grouped<V>(q: Promise<{ id: number; v: V }[]>): Promise<Map<number, V[]>> {
  const out = new Map<number, V[]>();
  for (const r of await q) out.set(r.id, [...(out.get(r.id) ?? []), r.v]);
  return out;
}

/** The list's rows for these ids, with the reports' extra facts. Still filtered by visibleSql (rowsOf). */
export async function reportRowsOf(tx: DbOrTx, scope: ListScope, ids: readonly number[]): Promise<ReportRow[]> {
  const base = await rowsOf(tx, scope, ids);
  if (base.length === 0) return [];
  const got = base.map((r) => r.id);
  const extra = new Map(
    (
      await tx
        .select({ id: activities.id, hqSection: activities.hqSection, longTermOutlook: activities.longTermOutlook, hqComments: activities.hqComments, nrAt: activities.nrAt })
        .from(activities)
        .where(inArray(activities.id, got))
    ).map((r) => [r.id, r]),
  );
  const categoryIds = await grouped(tx.select({ id: activityCategories.activityId, v: activityCategories.categoryId }).from(activityCategories).where(inArray(activityCategories.activityId, got)));
  const shared = await grouped(tx.select({ id: activitySharedWith.activityId, v: activitySharedWith.ministryKey }).from(activitySharedWith).where(inArray(activitySharedWith.activityId, got)));
  const shortNames = await grouped(
    tx
      .select({ id: activityInitiatives.activityId, v: initiatives.shortName })
      .from(activityInitiatives)
      .innerJoin(initiatives, eq(initiatives.id, activityInitiatives.initiativeId))
      .where(inArray(activityInitiatives.activityId, got))
      .orderBy(asc(initiatives.name)),
  );
  return base.map((r) => {
    const x = extra.get(r.id)!;
    const facts: VisibilityFacts = { contactMinistryKey: r.ministryKey, sharedMinistryKeys: shared.get(r.id) ?? [], isConfidential: r.isConfidential, isDeleted: r.isDeleted };
    return {
      ...r,
      categoryIds: categoryIds.get(r.id) ?? [],
      hqSection: x.hqSection,
      longTermOutlook: x.longTermOutlook,
      executiveSummary: can.seeLookAheadFieldset(scope.actor, scope.rules, facts) ? x.hqComments : null,
      initiatives: (shortNames.get(r.id) ?? []).filter((n): n is string => !!n),
      nrAt: x.nrAt?.toISOString() ?? null,
    };
  });
}

/**
 * What a report reads (spec addendum §10): the list's query and visibility, without the list's
 * default hides, never a deleted activity, in legacy's order. One snapshot, so the rows and "now" agree.
 */
export function reportData(deps: ApiDeps, actor: CalendarActor, q: ListQuery): Promise<ReportData> {
  return inReadSnapshot(deps.db, async (tx) => {
    const scope = await scopeOf(tx, deps, actor);
    const ids = (
      await tx
        .select({ id: activities.id })
        .from(activities)
        .where(and(listWhere(scope, q, { defaultHides: false }), isNull(activities.deletedAt)))
        .orderBy(...legacyReportOrder(deps.rules.timeZone))
        .limit(REPORT_ACTIVITY_LIMIT + 1)
    ).map((r) => r.id);
    if (ids.length > REPORT_ACTIVITY_LIMIT) throw new ReportTooLargeError();
    return { rows: await reportRowsOf(tx, scope, ids), scope, q, now: await dbNow(tx, deps.now) };
  });
}
