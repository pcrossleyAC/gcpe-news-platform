import { eq } from "drizzle-orm";
import { checkActivity, inferLookAhead, LEVEL, sectionToStore, warningsFor, type UpdateActivityInput } from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { can } from "../capabilities";
import { activities } from "../db/schema";
import { assertNotFrozen } from "../freeze";
import type { ApiDeps } from "../http/routes";
import { lockLookup, LOOKUPS } from "../lookups";
import { dbNow, wallClock } from "../time";
import { ActivityDeletedError, ActivityForbiddenError, ActivityNotFoundError, ActivityValidationError, VersionConflictError } from "./errors";
import { emitActivity } from "./events";
import { diffDisplay, displayOf, writeChange } from "./history";
import { assertNotLockedByOther, releaseOwnLocks } from "./locks";
import { createKeywords, resolveReferences } from "./resolve";
import { mergeNeedsReview, reviewChanges } from "./review-rules";
import {
  columnsOf, contentFrom, contentOf, factsOf, fieldsOf, keywordNamesOf, loadStored, lockActivity, lookAheadInputOf, lookAheadOf,
  replaceJoins, snapshotOf, uniqNum, uniqStr, type JoinIds, type LookAheadValues,
} from "./store";

/** Spec addendum §7.1 Update, under the activity's lock: checks, then one write, one history entry, one event. */
export async function updateActivity(deps: ApiDeps, actor: CalendarActor, id: number, input: UpdateActivityInput): Promise<{ warnings: string[] }> {
  // The tab id identifies the editor's tab; a save releases the saver's lock whichever tab holds it.
  const { version, tabId: _tabId, ...fields } = input;
  const { rules } = deps;
  return deps.db.transaction(async (tx) => {
    await lockActivity(tx, id);
    const s = await loadStored(tx, id, { forUpdate: true, visibleTo: actor });
    if (!s) throw new ActivityNotFoundError();
    if (s.row.deletedAt) throw new ActivityDeletedError();
    if (!can.edit(actor, factsOf(s))) throw new ActivityForbiddenError("Only the lead ministry and HQ edit this activity");
    const now = await dbNow(tx, deps.now);
    assertNotFrozen(now, actor, rules);
    await assertNotLockedByOther(tx, deps, actor, id);
    if (s.row.version !== version) throw new VersionConflictError();
    // After the activity's lock, so a concurrent save can't create the same new keyword twice.
    if (fields.keywordNames.length) await lockLookup(tx, LOOKUPS.keywords);

    const previous = fieldsOf(s, rules.timeZone);
    const refs = await resolveReferences(tx, fields, { actor, rules, previous: { stored: s, fields: previous } });
    const fieldset = can.seeLookAheadFieldset(actor, rules, factsOf(s));
    // An imported activity's second category, or several origins, stay while the editor's single choice is unchanged.
    const categoryIds = fields.categoryId === previous.categoryId ? s.joins.categoryIds : fields.categoryId === null ? [] : [fields.categoryId];
    const nrOriginIds = fields.nrOriginId === previous.nrOriginId ? s.joins.nrOriginIds : fields.nrOriginId === null ? [] : [fields.nrOriginId];
    const before = await lookAheadInputOf(tx, previous, s.joins.categoryIds, s.row.hqSection);
    const after = await lookAheadInputOf(tx, fields, categoryIds, s.row.hqSection);
    const inferred = inferLookAhead(after, rules);
    const errors = [
      ...checkActivity(fields, {
        rules,
        relaxRequired: can.relaxRequiredFields(actor),
        lookAheadFieldset: fieldset,
        previous,
        inferredSection: inferred.kind === "section" ? inferred.section : null,
      }),
      ...refs.errors,
    ];
    if (errors.length) throw new ActivityValidationError(errors);

    const created = await createKeywords(tx, refs.keywordsToCreate);
    const joins: JoinIds = {
      categoryIds,
      commMaterialIds: uniqNum(fields.commMaterialIds),
      initiativeIds: uniqNum(fields.initiativeIds),
      keywordIds: uniqNum([...refs.keywordIds, ...created]),
      nrOriginIds,
      sectorKeys: uniqStr(fields.sectorKeys),
      themeKeys: uniqStr(fields.themeKeys),
      tagKeys: uniqStr(fields.tagKeys),
      sharedWithKeys: uniqStr(fields.sharedWithKeys),
    };
    const content = contentFrom(fields, rules);
    const oldContent = contentOf(s.row);
    const oldLookAhead = lookAheadOf(s.row);
    const la = fields.lookAhead;
    // A fieldset user who leaves the fields out keeps the stored ones, their section included; everyone
    // else gets the section re-inferred. Either way sectionToStore keeps Awareness and consultations fixed.
    const chosen = fieldset ? (la?.hqSection ?? oldLookAhead.hqSection) : undefined;
    const hqSection = sectionToStore({ before, after, chosen }, rules);
    const lookAhead: LookAheadValues = fieldset && la
      ? { hqComments: la.hqComments.trim(), hqStatus: la.hqStatus, hqSection, longTermOutlook: la.longTermOutlook }
      : { ...oldLookAhead, hqSection };
    const { flags, statusChanged } = reviewChanges(snapshotOf(oldContent, s.joins), snapshotOf(content, joins));
    // Legacy (Activity.aspx.cs:1246-1252): an HQ Administrator's edit to another ministry's activity leaves
    // "last updated" alone. The version still moves, so it can't be overwritten silently (C129).
    const keepLastUpdated = actor.isHq && actor.level >= LEVEL.administrator && !(s.row.contactMinistryKey !== null && actor.ministryKeys.includes(s.row.contactMinistryKey));
    await tx
      .update(activities)
      .set({
        ...columnsOf(content),
        hqComments: lookAhead.hqComments || null,
        hqStatus: lookAhead.hqStatus,
        hqSection: lookAhead.hqSection,
        longTermOutlook: lookAhead.longTermOutlook,
        needsReview: mergeNeedsReview(s.row.needsReview, flags),
        ...(statusChanged ? { status: "changed" as const } : {}),
        ...(keepLastUpdated ? {} : { lastUpdatedAt: now, lastUpdatedBy: actor.userId }),
        version: s.row.version + 1,
      })
      .where(eq(activities.id, id));
    await replaceJoins(tx, id, joins);

    // A save that changes nothing still moves the version and emits, but leaves no history entry.
    const diff = diffDisplay(
      await displayOf(tx, oldContent, oldLookAhead, s.joins, s.keywordNames, rules),
      await displayOf(tx, content, lookAhead, joins, await keywordNamesOf(tx, joins.keywordIds), rules),
    );
    if (diff.length) await writeChange(tx, { activityId: id, actor, action: "updated", contactMinistryKey: content.contactMinistryKey, at: now, fields: diff });
    await releaseOwnLocks(tx, actor.userId, id);
    await emitActivity(tx, deps, id, "activity.updated");
    return { warnings: warningsFor(fields, wallClock(now, rules.timeZone).date) };
  });
}
