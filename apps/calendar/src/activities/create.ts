import { checkActivity, inferLookAhead, LEVEL, sectionToStore, warningsFor, type ActivityFields } from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { can } from "../capabilities";
import { assertNotFrozen } from "../freeze";
import type { ApiDeps } from "../http/routes";
import { lockLookup, LOOKUPS } from "../lookups";
import { dbNow, wallClock } from "../time";
import { ActivityForbiddenError, ActivityValidationError } from "./errors";
import { emitActivity } from "./events";
import { displayOf, setFields, writeChange } from "./history";
import { createKeywords, resolveReferences } from "./resolve";
import { contentFrom, insertActivity, keywordNamesOf, lookAheadInputOf, replaceJoins, uniqNum, uniqStr, type JoinIds, type LookAheadValues } from "./store";

/** Spec addendum §7.1 Create: status new, no flags, every field saved (C145), history and an event in one transaction. */
export async function createActivity(deps: ApiDeps, actor: CalendarActor, input: ActivityFields): Promise<{ id: number; warnings: string[] }> {
  // HQ always has its HQ organization among its ministries, so this asks "may they create anywhere".
  // Whether the chosen ministry is one of theirs is a field error from resolveReferences.
  if (!actor.ministryKeys.some((k) => can.create(actor, k))) throw new ActivityForbiddenError("Editors and above create activities, in their own ministries");
  return deps.db.transaction(async (tx) => {
    const now = await dbNow(tx, deps.now);
    assertNotFrozen(now, actor, deps.rules);
    // Before reading keywords, so a concurrent save can't create the same new keyword twice.
    if (input.keywordNames.length) await lockLookup(tx, LOOKUPS.keywords);
    const refs = await resolveReferences(tx, input, { actor, rules: deps.rules, previous: null });
    const fieldset = can.seeLookAheadFieldset(actor, deps.rules);
    const categoryIds = input.categoryId === null ? [] : [input.categoryId];
    const laInput = await lookAheadInputOf(tx, input, categoryIds, null);
    const inferred = inferLookAhead(laInput, deps.rules);
    const errors = [
      ...checkActivity(input, {
        rules: deps.rules,
        relaxRequired: can.relaxRequiredFields(actor),
        lookAheadFieldset: fieldset,
        previous: null,
        inferredSection: inferred.kind === "section" ? inferred.section : null,
      }),
      ...refs.errors,
    ];
    if (errors.length) throw new ActivityValidationError(errors);
    // checkActivity requires a lead ministry, and resolveReferences reports one the actor can't use.
    if (!can.create(actor, input.contactMinistryKey!)) throw new ActivityForbiddenError("You can only create in your own ministries");

    const section = sectionToStore({ before: null, after: laInput, chosen: fieldset ? input.lookAhead?.hqSection : undefined }, deps.rules);
    const la = input.lookAhead;
    const lookAhead: LookAheadValues = fieldset
      ? { hqComments: la ? la.hqComments.trim() : "**", hqStatus: la?.hqStatus ?? null, hqSection: section, longTermOutlook: la?.longTermOutlook ?? false }
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
      nrOriginIds: input.nrOriginId === null ? [] : [input.nrOriginId],
      sectorKeys: uniqStr(input.sectorKeys),
      themeKeys: uniqStr(input.themeKeys),
      tagKeys: uniqStr(input.tagKeys),
      sharedWithKeys: uniqStr(input.sharedWithKeys),
    };
    await replaceJoins(tx, id, joins);
    const keywordNames = await keywordNamesOf(tx, joins.keywordIds);
    const display = await displayOf(tx, content, lookAhead, joins, keywordNames, deps.rules);
    await writeChange(tx, { activityId: id, actor, action: "created", contactMinistryKey: content.contactMinistryKey, at: now, fields: setFields(display) });
    await emitActivity(tx, deps, id, "activity.created");
    return { id, warnings: warningsFor(input, wallClock(now, deps.rules.timeZone).date) };
  });
}
