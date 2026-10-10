import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Tx } from "@gcpe/db-kit";
import {
  HISTORY_FIELDS, inferLookAhead, LOOK_AHEAD_HISTORY_FIELDS, type ActivityChangeView, type ActivityView, type ChangeAction, type HistoryFieldKey,
} from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { can } from "../capabilities";
import { activityChangeFields, activityChanges, favourites, orgs, releaseLinks, users } from "../db/schema";
import type { ApiDeps } from "../http/routes";
import { filesOf } from "./files";
import { ActivityNotFoundError } from "./errors";
import { factsOf, fieldsOf, inReadSnapshot, liveLockOf, loadStored, lookAheadInputOf, type StoredActivity } from "./store";

/** Not visible is not found, never forbidden (spec addendum §6). */
async function loadVisible(tx: Tx, actor: CalendarActor, id: number): Promise<StoredActivity> {
  const s = await loadStored(tx, id, { visibleTo: actor });
  if (!s) throw new ActivityNotFoundError();
  return s;
}

export function readActivity(deps: ApiDeps, actor: CalendarActor, id: number): Promise<ActivityView> {
  return inReadSnapshot(deps.db, async (tx) => viewOf(tx, deps, actor, await loadVisible(tx, actor, id)));
}

async function viewOf(tx: Tx, deps: ApiDeps, actor: CalendarActor, s: StoredActivity): Promise<ActivityView> {
  const { rules } = deps;
  const facts = factsOf(s);
  const fields = fieldsOf(s, rules.timeZone);
  const fieldset = can.seeLookAheadFieldset(actor, rules, facts);
  const lock = await liveLockOf(tx, s.row.id, deps.now);
  const [updater] = s.row.lastUpdatedBy ? await tx.select({ name: users.displayName }).from(users).where(eq(users.id, s.row.lastUpdatedBy)) : [];
  const lookAhead = fields.lookAhead!;
  if (!fieldset) delete fields.lookAhead;
  const [org] = s.row.contactMinistryKey ? await tx.select({ abbreviation: orgs.abbreviation }).from(orgs).where(eq(orgs.key, s.row.contactMinistryKey)) : [];
  const watchers = await tx
    .select({ userId: favourites.userId, name: users.displayName })
    .from(favourites)
    .innerJoin(users, eq(users.id, favourites.userId))
    .where(eq(favourites.activityId, s.row.id))
    .orderBy(asc(users.displayName));
  const releases = await tx
    .select()
    .from(releaseLinks)
    .where(and(eq(releaseLinks.activityId, s.row.id), ne(releaseLinks.status, "deleted")))
    .orderBy(sql`${releaseLinks.publishAt} ASC NULLS LAST`, asc(releaseLinks.releaseId));
  return {
    id: s.row.id,
    ministryAbbreviation: org?.abbreviation ?? null,
    version: s.row.version,
    status: s.row.status,
    isDeleted: facts.isDeleted,
    fields,
    startAt: s.row.startAt?.toISOString() ?? null,
    endAt: s.row.endAt?.toISOString() ?? null,
    nrAt: s.row.nrAt?.toISOString() ?? null,
    lookAhead: fieldset ? { ...lookAhead, inferred: inferLookAhead(await lookAheadInputOf(tx, fields, s.joins.categoryIds, s.row.hqSection), rules) } : null,
    needsReview: can.seeNeedsReviewMarkup(actor) ? s.row.needsReview : [],
    createdAt: s.row.createdAt.toISOString(),
    lastUpdatedAt: s.row.lastUpdatedAt.toISOString(),
    lastUpdatedByName: updater?.name ?? null,
    lock: lock ? { holderName: lock.holderName, since: lock.acquiredAt.toISOString(), mine: lock.userId === actor.userId, tabId: lock.userId === actor.userId ? lock.tabId : null } : null,
    can: { edit: can.edit(actor, facts), clone: can.clone(actor, facts), delete: can.delete(actor, facts), review: can.review(actor, facts) },
    watch: { isWatched: watchers.some((x) => x.userId === actor.userId), watcherNames: watchers.map((x) => x.name) },
    files: await filesOf(tx, s.row.id),
    releases: releases.map((r) => ({
      releaseId: r.releaseId, type: r.type, status: r.status, reference: r.reference,
      publishAt: r.publishAt?.toISOString() ?? null, releasedAt: r.releasedAt?.toISOString() ?? null,
    })),
  };
}

const LOOK_AHEAD_KEYS: ReadonlySet<string> = new Set(LOOK_AHEAD_HISTORY_FIELDS);
/** Entries that exist only to record field changes: with every field hidden, nothing is left to show. */
const FIELD_ONLY_ACTIONS: ReadonlySet<ChangeAction> = new Set(["updated", "la_status_cleared"]);

/**
 * "View changes" (spec addendum §8.3): newest first, for anyone who can see the activity. The Look
 * Ahead fields are shown only to those who see that fieldset on this activity, as the view does.
 */
export function readChanges(deps: ApiDeps, actor: CalendarActor, id: number): Promise<ActivityChangeView[]> {
  return inReadSnapshot(deps.db, async (tx) => {
    const s = await loadVisible(tx, actor, id);
    const showLookAhead = can.seeLookAheadFieldset(actor, deps.rules, factsOf(s));
    const changes = await tx.select().from(activityChanges).where(eq(activityChanges.activityId, id)).orderBy(desc(activityChanges.at), desc(activityChanges.id));
    const fields = changes.length ? await tx.select().from(activityChangeFields).where(inArray(activityChangeFields.changeId, changes.map((c) => c.id))) : [];
    const order = Object.keys(HISTORY_FIELDS);
    return changes.flatMap((c) => {
      const all = fields.filter((f) => f.changeId === c.id);
      const shown = showLookAhead ? all : all.filter((f) => !LOOK_AHEAD_KEYS.has(f.fieldKey));
      if (shown.length === 0 && all.length > 0 && FIELD_ONLY_ACTIONS.has(c.action)) return [];
      return [{
        id: c.id,
        at: c.at.toISOString(),
        actorName: c.actorName,
        action: c.action,
        source: c.source,
        fields: shown
          .sort((a, b) => order.indexOf(a.fieldKey) - order.indexOf(b.fieldKey))
          .map((f) => ({ key: f.fieldKey, label: HISTORY_FIELDS[f.fieldKey as HistoryFieldKey] ?? f.fieldKey, old: f.oldValue, new: f.newValue })),
      }];
    });
  });
}
