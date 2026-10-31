import { checkActivity, inferLookAhead, LEVEL, sectionToStore, warningsFor, type ActivityFields, type CreateActivityInput } from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { can } from "../capabilities";
import { assertNotFrozen } from "../freeze";
import type { ApiDeps } from "../http/routes";
import { lockLookup, LOOKUPS } from "../lookups";
import { dbNow, wallClock } from "../time";
import { cloneLookAhead, cloneSource } from "./clone";
import { ActivityDeletedError, ActivityForbiddenError, ActivityNotFoundError, ActivityValidationError } from "./errors";
import { emitActivity } from "./events";
import { displayOf, setFields, writeChange } from "./history";
import { createKeywords, resolveReferences } from "./resolve";
import { contentFrom, fieldsOf, insertActivity, keywordNamesOf, lookAheadInputOf, replaceJoins, uniqNum, uniqStr, type JoinIds, type LookAheadValues, type StoredActivity } from "./store";

/** Why a Clone form's save can't name its source any more: said in the form's error summary. */
export const CLONE_SOURCE_GONE = "You can no longer copy the activity this was copied from. Start a new activity instead.";

/**
 * Spec addendum §7.1 Create: status new, no flags, every field saved (C145), history and an event in one transaction.
 * With `clonedFrom` it is a clone saved from the Clone form (owner, 2026-10-31): checked as cloneActivity
 * checks one (an inactive value the source holds carries over; the lead ministry and comm contact are
 * new choices), given the clone's Look Ahead fields, and recorded as "cloned" from the source.
 */
export async function createActivity(deps: ApiDeps, actor: CalendarActor, body: CreateActivityInput): Promise<{ id: number; warnings: string[] }> {
  const { clonedFrom, ...input }: { clonedFrom?: number } & ActivityFields = body;
  // HQ always has its HQ organization among its ministries, so this asks "may they create anywhere".
  // Whether the chosen ministry is one of theirs is a field error from resolveReferences.
  if (!actor.ministryKeys.some((k) => can.create(actor, k))) throw new ActivityForbiddenError("Editors and above create activities, in their own ministries");
  return deps.db.transaction(async (tx) => {
    const now = await dbNow(tx, deps.now);
    assertNotFrozen(now, actor, deps.rules);
    let source: StoredActivity | null = null;
    if (clonedFrom !== undefined) {
      source = await cloneSource(tx, actor, clonedFrom).catch((e: unknown) => {
        // Gone, deleted or no longer theirs since the form opened: a field error, never a 404 for the activity being created.
        if (e instanceof ActivityNotFoundError || e instanceof ActivityDeletedError || e instanceof ActivityForbiddenError) {
          throw new ActivityValidationError([{ field: "", message: CLONE_SOURCE_GONE }]);
        }
        throw e;
      });
    }
    // Before reading keywords, so a concurrent save can't create the same new keyword twice.
    if (input.keywordNames.length) await lockLookup(tx, LOOKUPS.keywords);
    // A clone's values are judged against its source's, but its lead ministry and comm contact as new choices (clone.ts).
    const sourceFields = source ? { ...fieldsOf(source, deps.rules.timeZone), contactMinistryKey: null, commContactId: null } : null;
    const previous = source && sourceFields ? { stored: source, fields: sourceFields } : null;
    const refs = await resolveReferences(tx, input, { actor, rules: deps.rules, previous });
    const fieldset = can.seeLookAheadFieldset(actor, deps.rules);
    // A clone keeps an imported activity's second category, or several origins, while the single choice is unchanged.
    const categoryIds = source && input.categoryId === sourceFields!.categoryId ? source.joins.categoryIds : input.categoryId === null ? [] : [input.categoryId];
    const nrOriginIds = source && input.nrOriginId === sourceFields!.nrOriginId ? source.joins.nrOriginIds : input.nrOriginId === null ? [] : [input.nrOriginId];
    const before = source ? await lookAheadInputOf(tx, sourceFields!, source.joins.categoryIds, source.row.hqSection) : null;
    const laInput = await lookAheadInputOf(tx, input, categoryIds, source?.row.hqSection ?? null);
    const inferred = inferLookAhead(laInput, deps.rules);
    const errors = [
      ...checkActivity(input, {
        rules: deps.rules,
        relaxRequired: can.relaxRequiredFields(actor),
        lookAheadFieldset: fieldset,
        previous: sourceFields,
        inferredSection: inferred.kind === "section" ? inferred.section : null,
      }),
      ...refs.errors,
    ];
    if (errors.length) throw new ActivityValidationError(errors);
    // checkActivity requires a lead ministry, and resolveReferences reports one the actor can't use.
    if (!can.create(actor, input.contactMinistryKey!)) throw new ActivityForbiddenError("You can only create in your own ministries");

    const la = input.lookAhead;
    const chosen = fieldset ? (la?.hqSection ?? source?.row.hqSection) : undefined;
    const section = sectionToStore({ before, after: laInput, chosen }, deps.rules);
    const lookAhead: LookAheadValues = fieldset && (la || !source)
      ? { hqComments: la ? la.hqComments.trim() : "**", hqStatus: la?.hqStatus ?? null, hqSection: section, longTermOutlook: la?.longTermOutlook ?? false }
      : source
        ? { ...cloneLookAhead(source.row), hqSection: section }
        : // Draws HQ's attention to a ministry's new activity (Activity.aspx.cs:1098-1102).
          { hqComments: actor.level < LEVEL.administrator ? "**" : "", hqStatus: null, hqSection: section, longTermOutlook: false };
    const content = contentFrom(input, deps.rules);
    const id = await insertActivity(tx, { content, lookAhead, actorId: actor.userId, at: now });
    const created = await createKeywords(tx, refs.keywordsToCreate);
    const joins: JoinIds = {
      categoryIds,
      commMaterialIds: uniqNum(input.commMaterialIds),
      initiativeIds: uniqNum(input.initiativeIds),
      keywordIds: uniqNum([...refs.keywordIds, ...created]),
      nrOriginIds,
      sectorKeys: uniqStr(input.sectorKeys),
      themeKeys: uniqStr(input.themeKeys),
      tagKeys: uniqStr(input.tagKeys),
      sharedWithKeys: uniqStr(input.sharedWithKeys),
    };
    await replaceJoins(tx, id, joins);
    const keywordNames = await keywordNamesOf(tx, joins.keywordIds);
    const display = await displayOf(tx, content, lookAhead, joins, keywordNames, deps.rules);
    await writeChange(tx, {
      activityId: id, actor, action: source ? "cloned" : "created", contactMinistryKey: content.contactMinistryKey, at: now,
      fields: [...(source ? [{ key: "cloned_from" as const, old: null, new: String(source.row.id) }] : []), ...setFields(display)],
    });
    await emitActivity(tx, deps, id, "activity.created");
    return { id, warnings: warningsFor(input, wallClock(now, deps.rules.timeZone).date) };
  });
}
