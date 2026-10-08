import { and, inArray, sql } from "drizzle-orm";
import type { CalendarActor } from "../actor";
import { can } from "../capabilities";
import { keywords } from "../db/schema";
import { assertNotFrozen } from "../freeze";
import type { ApiDeps } from "../http/routes";
import { dbNow } from "../time";
import { visible } from "../visibility";
import { ActivityDeletedError, ActivityForbiddenError, ActivityNotFoundError } from "./errors";
import { emitActivity } from "./events";
import { displayOf, setFields, writeChange } from "./history";
import { contentOf, factsOf, insertActivity, keywordNamesOf, loadStored, lockActivity, replaceJoins, type LookAheadValues } from "./store";

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

    const content = { ...contentOf(s.row), nrAt: null, comments: "" };
    const lookAhead: LookAheadValues = { hqComments: "**", hqStatus: null, hqSection: s.row.hqSection, longTermOutlook: s.row.longTermOutlook };
    const kept = deps.rules.cloneKeptKeywordNames.map((k) => k.toLowerCase());
    const keptIds =
      s.joins.keywordIds.length && kept.length
        ? (await tx.select({ id: keywords.id }).from(keywords).where(and(inArray(keywords.id, s.joins.keywordIds), inArray(sql`lower(${keywords.name})`, kept)))).map((k) => k.id)
        : [];
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
