import { sql, type SQL } from "drizzle-orm";

/**
 * Suite review fix round 2, M4 (controller ruling 2026-11-01): which newer event for the same record
 * can stand in for an older one, so the older one never needs sending again (undelivered.ts
 * "replaced"). Defined once, per event family:
 *
 * - A full-record event (an upsert, a deactivation, an activity, a terms or settings publish)
 *   is replaced by any newer event of its family: the newer one carries the whole current state.
 * - `release.published` is replaced only by a newer publish or an unpublish. A `release.updated`
 *   can't stand in for it: News On Demand only refreshes an item it already has, and creates or
 *   emails nothing.
 * - An event that is an action rather than a state (a bounce, an organization hand-over, a
 *   rebuild request), or a type not listed here, is never replaced: it keeps alerting until it is
 *   sent or dismissed.
 *
 * Each entry: the older event's types, and the newer types that replace it.
 */
const RULES: { types: string[]; replacedBy: string[] }[] = [
  { types: ["release.published"], replacedBy: ["release.published", "release.unpublished"] },
  { types: ["release.updated"], replacedBy: ["release.published", "release.updated", "release.unpublished"] },
  { types: ["release.unpublished"], replacedBy: ["release.published", "release.unpublished"] },
  { types: ["release.status_changed"], replacedBy: ["release.status_changed"] },
  { types: ["org.upserted", "org.deactivated"], replacedBy: ["org.upserted", "org.deactivated"] },
  { types: ["user.upserted"], replacedBy: ["user.upserted"] },
  ...["sector", "theme", "tag", "service"].map((k) => ({ types: [`${k}.upserted`, `${k}.deactivated`], replacedBy: [`${k}.upserted`, `${k}.deactivated`] })),
  { types: ["media_list.created", "media_list.updated", "media_list.deactivated"], replacedBy: ["media_list.created", "media_list.updated", "media_list.deactivated"] },
  { types: ["activity.created", "activity.updated", "activity.deleted"], replacedBy: ["activity.created", "activity.updated", "activity.deleted"] },
  { types: ["site.content.changed"], replacedBy: ["site.content.changed"] },
  { types: ["site.settings.published"], replacedBy: ["site.settings.published"] },
  { types: ["government_terms.published"], replacedBy: ["government_terms.published"] },
];

const BY_TYPE = new Map(RULES.flatMap((r) => r.types.map((t) => [t, r.replacedBy] as const)));

/** A newer event of type `newer`, for the same record and receiving app, stands in for one of type `older`. */
export function canReplace(older: string, newer: string): boolean {
  return BY_TYPE.get(older)?.includes(newer) ?? false;
}

/** The same rule in SQL, comparing the older event's type column with the newer one's. */
export function canReplaceSql(older: SQL, newer: SQL): SQL {
  const cases = [...BY_TYPE].map(([t, by]) => sql`WHEN ${older} = ${t} THEN ${newer} IN (${sql.join(by.map((b) => sql`${b}`), sql`, `)})`);
  return sql`(CASE ${sql.join(cases, sql` `)} ELSE false END)`;
}
