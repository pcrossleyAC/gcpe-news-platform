import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { CalendarRules, ClonePrefill } from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { can } from "../capabilities";
import { commContacts, keywords, orgs, users } from "../db/schema";
import { assertNotFrozen } from "../freeze";
import type { ApiDeps } from "../http/routes";
import { dbNow } from "../time";
import { visible } from "../visibility";
import { ActivityDeletedError, ActivityForbiddenError, ActivityNotFoundError, ActivityValidationError } from "./errors";
import { emitActivity } from "./events";
import { INACTIVE_CONTACT, INACTIVE_PERSON } from "./resolve";
import { displayOf, setFields, writeChange } from "./history";
import { contentOf, factsOf, fieldsOf, inReadSnapshot, insertActivity, keywordNamesOf, loadStored, lockActivity, replaceJoins, type ActivityRow, type LookAheadValues, type StoredActivity } from "./store";

/** Of the activity's keywords, those a clone keeps: the tenant's kept names, matched case-insensitively (ActivityWebService.cs:430). */
export async function keptKeywordIds(db: DbOrTx, rules: Pick<CalendarRules, "cloneKeptKeywordNames">, ids: readonly number[]): Promise<number[]> {
  const kept = rules.cloneKeptKeywordNames.map((k) => k.toLowerCase());
  if (!ids.length || !kept.length) return [];
  return (await db.select({ id: keywords.id }).from(keywords).where(and(inArray(keywords.id, [...ids]), inArray(sql`lower(${keywords.name})`, kept)))).map((k) => k.id);
}

/** A clone's Look Ahead fields: ** draws HQ's attention, no LA status; the section and Long Term Outlook carry over. */
export const cloneLookAhead = (r: ActivityRow): LookAheadValues => ({ hqComments: "**", hqStatus: null, hqSection: r.hqSection, longTermOutlook: r.longTermOutlook });

/**
 * The activity a clone is made from, or why it can't be: not visible is not found, deleted is
 * deleted, and only someone who could edit it may clone it (spec addendum §6).
 */
export async function cloneSource(tx: DbOrTx, actor: CalendarActor, sourceId: number): Promise<StoredActivity> {
  const s = await loadStored(tx, sourceId);
  if (!s || !visible(actor, factsOf(s))) throw new ActivityNotFoundError();
  if (s.row.deletedAt) throw new ActivityDeletedError();
  if (!can.clone(actor, factsOf(s))) throw new ActivityForbiddenError("Only the lead ministry and HQ clone this activity");
  return s;
}

/**
 * The New activity form's values for a clone (owner, 2026-10-31): exactly what cloneActivity copies,
 * as fields, with nothing created. Saving them with `clonedFrom` (create.ts) makes the clone.
 */
export function clonePrefill(deps: ApiDeps, actor: CalendarActor, sourceId: number): Promise<ClonePrefill> {
  return inReadSnapshot(deps.db, async (tx) => {
    const s = await cloneSource(tx, actor, sourceId);
    const keptIds = await keptKeywordIds(tx, deps.rules, s.joins.keywordIds);
    const fields = { ...fieldsOf(s, deps.rules.timeZone), nrDate: null, nrTime: null, comments: "", keywordNames: await keywordNamesOf(tx, keptIds), tagKeys: [] };
    if (can.seeLookAheadFieldset(actor, deps.rules)) fields.lookAhead = cloneLookAhead(s.row);
    else delete fields.lookAhead;
    const [org] = s.row.contactMinistryKey ? await tx.select({ abbreviation: orgs.abbreviation }).from(orgs).where(eq(orgs.key, s.row.contactMinistryKey)) : [];
    return { sourceId, sourceLabel: `${org?.abbreviation ?? "—"}-${sourceId}`, fields };
  });
}

/**
 * Spec addendum §7.1 Clone (ActivityWebService.cs:72-140), from the stored activity: NR date cleared,
 * internal notes emptied, Executive Summary **, News Subscribe dropped, only the tenant's kept keywords,
 * status new. Event planner, Digital and Translations are copied too, which legacy's fixed list missed.
 */
export async function cloneActivity(deps: ApiDeps, actor: CalendarActor, sourceId: number): Promise<{ id: number }> {
  return deps.db.transaction(async (tx) => {
    await lockActivity(tx, sourceId);
    const s = await loadStored(tx, sourceId, { forUpdate: true });
    if (!s || !visible(actor, factsOf(s))) throw new ActivityNotFoundError();
    if (s.row.deletedAt) throw new ActivityDeletedError();
    if (!can.clone(actor, factsOf(s))) throw new ActivityForbiddenError("Only the lead ministry and HQ clone this activity");
    const now = await dbNow(tx, deps.now);
    assertNotFrozen(now, actor, deps.rules);

    // A clone is a new assignment to its carried-over contact ministry, checked exactly as create
    // checks one (resolve.ts's contactMinistryKey block): the ministry must still exist and be
    // active, and the actor must be allowed to use it. Own-ministry users already had this ministry
    // checked by can.clone above; this also catches HQ cloning into a ministry that no longer exists
    // or has since been deactivated.
    if (s.row.contactMinistryKey !== null) {
      const [org] = await tx.select().from(orgs).where(eq(orgs.key, s.row.contactMinistryKey));
      if (!org) throw new ActivityValidationError([{ field: "contactMinistryKey", message: "That ministry doesn't exist" }]);
      if (!org.isActive) throw new ActivityValidationError([{ field: "contactMinistryKey", message: "That ministry is no longer active" }]);
      if (org.abbreviation && deps.rules.contactMinistryExcludedAbbreviations.includes(org.abbreviation)) {
        throw new ActivityValidationError([{ field: "contactMinistryKey", message: "That ministry can't lead an activity" }]);
      }
      if (!can.create(actor, s.row.contactMinistryKey)) throw new ActivityForbiddenError("You can only clone into one of your ministries");
    }
    // The carried-over comm contact is a new assignment too, checked as a save checks a newly
    // chosen one (resolve.ts): the contact and its person must be active. Other inactive lookup
    // values carry over unchecked, as legacy's clone copied them.
    if (s.row.commContactId !== null) {
      const [c] = await tx
        .select({ isActive: commContacts.isActive, userIsActive: users.isActive })
        .from(commContacts)
        .leftJoin(users, eq(users.id, commContacts.userId))
        .where(eq(commContacts.id, s.row.commContactId));
      if (c && !c.isActive) throw new ActivityValidationError([{ field: "commContactId", message: INACTIVE_CONTACT }]);
      if (c && c.userIsActive !== true) throw new ActivityValidationError([{ field: "commContactId", message: INACTIVE_PERSON }]);
    }

    const content = { ...contentOf(s.row), nrAt: null, comments: "" };
    // hqSection and longTermOutlook carry over unchanged, as every other copied field does.
    const lookAhead = cloneLookAhead(s.row);
    const keptIds = await keptKeywordIds(tx, deps.rules, s.joins.keywordIds);
    const joins = { ...s.joins, keywordIds: keptIds, tagKeys: [] };
    const id = await insertActivity(tx, { content, lookAhead, actorId: actor.userId, at: now });
    await replaceJoins(tx, id, joins);
    const display = await displayOf(tx, content, lookAhead, joins, await keywordNamesOf(tx, keptIds), deps.rules);
    await writeChange(tx, {
      activityId: id, actor, action: "cloned", contactMinistryKey: content.contactMinistryKey, at: now,
      fields: [{ key: "cloned_from", old: null, new: String(sourceId) }, ...setFields(display)],
    });
    await emitActivity(tx, deps, id, "activity.created");
    return { id };
  });
}
