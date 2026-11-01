import { sql, type SQL } from "drizzle-orm";

/**
 * Suite review fix rounds 2–3 (controller rulings 2026-11-01): which newer event for the same record
 * can stand in for an older one, so the older one never needs sending again (undelivered.ts
 * "replaced"). One rule per event family, below; anything not listed is never replaced, so it keeps
 * alerting until it is sent or dismissed.
 *
 * On top of the table: an event that carries a request to email a release again (`emailAgain`) is an
 * action, which the receiver takes only from the event carrying it. It is replaced only by a newer
 * event whose request covers every audience it asked for (subscribers, media lists), or by the
 * release's unpublish (rounds 3–4, M5 and N9).
 *
 * Each entry: the older event's types, and the newer types that replace it.
 */
const RULES: { types: string[]; replacedBy: string[] }[] = [
  // Releases. News On Demand creates an item, and emails, only from a publish; a correction just
  // refreshes an item it already has. So only a newer publish, or the unpublish, stands in for a publish.
  { types: ["release.published"], replacedBy: ["release.published", "release.unpublished"] },
  // A correction is the whole record: any newer publish, correction or unpublish stands in for it.
  { types: ["release.updated"], replacedBy: ["release.published", "release.updated", "release.unpublished"] },
  // An unpublish is undone or repeated only by a newer publish or unpublish.
  { types: ["release.unpublished"], replacedBy: ["release.published", "release.unpublished"] },
  // The release's status for the Calendar: the newest is the whole story.
  { types: ["release.status_changed"], replacedBy: ["release.status_changed"] },

  // Organizations, terms and media lists (round 3, M5). An upsert is the full record, its active
  // flag included, so it stands in for an older upsert or deactivation. A deactivation carries only
  // the key, so it stands in only for an older deactivation: an older upsert (a rename, or the
  // record's first appearance) still has to be sent.
  { types: ["org.upserted"], replacedBy: ["org.upserted"] },
  { types: ["org.deactivated"], replacedBy: ["org.upserted", "org.deactivated"] },
  ...["sector", "theme", "tag", "service"].flatMap((k) => [
    { types: [`${k}.upserted`], replacedBy: [`${k}.upserted`] },
    { types: [`${k}.deactivated`], replacedBy: [`${k}.upserted`, `${k}.deactivated`] },
  ]),
  { types: ["media_list.created", "media_list.updated"], replacedBy: ["media_list.created", "media_list.updated"] },
  { types: ["media_list.deactivated"], replacedBy: ["media_list.created", "media_list.updated", "media_list.deactivated"] },

  // A user: the whole record every time.
  { types: ["user.upserted"], replacedBy: ["user.upserted"] },
  // Calendar activities: each event carries the whole activity (or its deletion), and NRMS applies
  // them all through one upsert.
  { types: ["activity.created", "activity.updated", "activity.deleted"], replacedBy: ["activity.created", "activity.updated", "activity.deleted"] },
  // Website content, settings and government terms: each publish carries the whole current state.
  { types: ["site.content.changed"], replacedBy: ["site.content.changed"] },
  { types: ["site.settings.published"], replacedBy: ["site.settings.published"] },
  { types: ["government_terms.published"], replacedBy: ["government_terms.published"] },
  // Never replaced, as actions rather than state: delivery.bounced, org.succeeded (a hand-over),
  // site.rebuild_requested.
];

const BY_TYPE = new Map(RULES.flatMap((r) => r.types.map((t) => [t, r.replacedBy] as const)));

/** The unpublish that also ends any request to email the release again. */
const WITHDRAW = "release.unpublished";

/** Who an email-again request asks to email (catalogue emailAgainSchema). */
export interface EmailAgainAudience {
  subscribers: boolean;
  mediaLists: boolean;
}

export interface EventKind {
  type: string;
  /** The event carries a request to email the release again, to these audiences. */
  emailAgain?: EmailAgainAudience;
}

/** `newer` asks to email at least everyone `older` asked to (fix round 4, N9). */
const covers = (older: EmailAgainAudience, newer: EmailAgainAudience | undefined) =>
  newer !== undefined && (!older.subscribers || newer.subscribers) && (!older.mediaLists || newer.mediaLists);

/** A newer event, for the same record and receiving app, stands in for the older one. */
export function canReplace(older: EventKind, newer: EventKind): boolean {
  if (!(BY_TYPE.get(older.type)?.includes(newer.type) ?? false)) return false;
  return !older.emailAgain || newer.type === WITHDRAW || covers(older.emailAgain, newer.emailAgain);
}

/** One audience flag of the event row aliased `alias`'s email-again request (false when absent). */
const audience = (alias: string, field: "subscribers" | "mediaLists") => sql.raw(`COALESCE((${alias}.envelope -> 'data' -> 'emailAgain' ->> '${field}')::boolean, false)`);
const hasEmailAgain = (alias: string) => sql.raw(`(${alias}.envelope -> 'data' ? 'emailAgain')`);

/** The same rule in SQL, comparing the older event row (alias) with the newer one (alias). */
export function canReplaceSql(older: string, newer: string): SQL {
  const o = sql.raw(`${older}.type`);
  const n = sql.raw(`${newer}.type`);
  const cases = [...BY_TYPE].map(([t, by]) => sql`WHEN ${o} = ${t} THEN ${n} IN (${sql.join(by.map((b) => sql`${b}`), sql`, `)})`);
  const covered = sql`(${hasEmailAgain(newer)} AND (NOT ${audience(older, "subscribers")} OR ${audience(newer, "subscribers")}) AND (NOT ${audience(older, "mediaLists")} OR ${audience(newer, "mediaLists")}))`;
  return sql`((CASE ${sql.join(cases, sql` `)} ELSE false END) AND (NOT ${hasEmailAgain(older)} OR ${n} = ${WITHDRAW} OR ${covered}))`;
}
