import { desc, eq, inArray } from "drizzle-orm";
import { HISTORY_FIELDS, inferLookAhead, type ActivityChangeView, type ActivityView, type HistoryFieldKey } from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { can } from "../capabilities";
import { activityChangeFields, activityChanges, users } from "../db/schema";
import type { ApiDeps } from "../http/routes";
import { ActivityNotFoundError } from "./errors";
import { factsOf, fieldsOf, liveLockOf, loadStored, lookAheadInputOf, type StoredActivity } from "./store";

/** Not visible is not found, never forbidden (spec addendum §6). */
async function loadVisible(deps: ApiDeps, actor: CalendarActor, id: number): Promise<StoredActivity> {
  const s = await loadStored(deps.db, id, { visibleTo: actor });
  if (!s) throw new ActivityNotFoundError();
  return s;
}

export async function readActivity(deps: ApiDeps, actor: CalendarActor, id: number): Promise<ActivityView> {
  return viewOf(deps, actor, await loadVisible(deps, actor, id));
}

async function viewOf(deps: ApiDeps, actor: CalendarActor, s: StoredActivity): Promise<ActivityView> {
  const { db, rules } = deps;
  const facts = factsOf(s);
  const fields = fieldsOf(s, rules.timeZone);
  const fieldset = can.seeLookAheadFieldset(actor, rules, facts);
  const lock = await liveLockOf(db, s.row.id, deps.now);
  const [updater] = s.row.lastUpdatedBy ? await db.select({ name: users.displayName }).from(users).where(eq(users.id, s.row.lastUpdatedBy)) : [];
  const lookAhead = fields.lookAhead!;
  if (!fieldset) delete fields.lookAhead;
  return {
    id: s.row.id,
    version: s.row.version,
    status: s.row.status,
    isDeleted: facts.isDeleted,
    fields,
    startAt: s.row.startAt?.toISOString() ?? null,
    endAt: s.row.endAt?.toISOString() ?? null,
    nrAt: s.row.nrAt?.toISOString() ?? null,
    lookAhead: fieldset ? { ...lookAhead, inferred: inferLookAhead(await lookAheadInputOf(db, fields, s.joins.categoryIds, s.row.hqSection), rules) } : null,
    needsReview: can.seeNeedsReviewMarkup(actor) ? s.row.needsReview : [],
    createdAt: s.row.createdAt.toISOString(),
    lastUpdatedAt: s.row.lastUpdatedAt.toISOString(),
    lastUpdatedByName: updater?.name ?? null,
    lock: lock ? { holderName: lock.holderName, since: lock.acquiredAt.toISOString(), mine: lock.userId === actor.userId, tabId: lock.userId === actor.userId ? lock.tabId : null } : null,
    can: { edit: can.edit(actor, facts), clone: can.clone(actor, facts), delete: can.delete(actor, facts), review: can.review(actor, facts) },
  };
}

/** "View changes" (spec addendum §8.3): newest first, for anyone who can see the activity. */
export async function readChanges(deps: ApiDeps, actor: CalendarActor, id: number): Promise<ActivityChangeView[]> {
  await loadVisible(deps, actor, id);
  const changes = await deps.db.select().from(activityChanges).where(eq(activityChanges.activityId, id)).orderBy(desc(activityChanges.at), desc(activityChanges.id));
  const fields = changes.length ? await deps.db.select().from(activityChangeFields).where(inArray(activityChangeFields.changeId, changes.map((c) => c.id))) : [];
  const order = Object.keys(HISTORY_FIELDS);
  return changes.map((c) => ({
    id: c.id,
    at: c.at.toISOString(),
    actorName: c.actorName,
    action: c.action,
    source: c.source,
    fields: fields
      .filter((f) => f.changeId === c.id)
      .sort((a, b) => order.indexOf(a.fieldKey) - order.indexOf(b.fieldKey))
      .map((f) => ({ key: f.fieldKey, label: HISTORY_FIELDS[f.fieldKey as HistoryFieldKey] ?? f.fieldKey, old: f.oldValue, new: f.newValue })),
  }));
}
