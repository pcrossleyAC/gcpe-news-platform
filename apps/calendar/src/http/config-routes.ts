import { and, eq, inArray } from "drizzle-orm";
import { Router } from "express";
import { editorRulesOf } from "@gcpe/calendar-contract";
import { editorOptions } from "../activities/editor-options";
import { can } from "../capabilities";
import { orgs } from "../db/schema";
import { freezeStateAt } from "../freeze";
import { dbNow } from "../time";
import type { ApiDeps } from "./routes";

/** The actor's own ministries that are still active — an HQ actor's `can.create` doesn't depend
 * on which of their own ministries are active (they may pick any active one when they actually
 * create), so only a non-HQ actor's own ministries need the check: they can only create in one
 * of their own, and `resolve.ts` refuses an inactive one there regardless. Without this, an
 * Editor whose only ministry has gone inactive would be offered "New activity" and get a 422. */
async function ownActiveMinistryKeys(deps: ApiDeps, actor: { isHq: boolean; ministryKeys: string[] }): Promise<string[]> {
  if (actor.isHq || actor.ministryKeys.length === 0) return actor.ministryKeys;
  const rows = await deps.db.select({ key: orgs.key }).from(orgs).where(and(inArray(orgs.key, actor.ministryKeys), eq(orgs.isActive, true)));
  return rows.map((r) => r.key);
}

/** What the list and the editor need from the tenant's calendar section, and the freeze as it
 * stands for the caller (spec addendum §7.4: the standing banner and the read-only editor). */
export function configRoutes(deps: ApiDeps): Router {
  const r = Router();
  r.get("/config", async (req, res, next) => {
    try {
      const actor = req.calendar!;
      const { rules } = deps;
      const activeMinistryKeys = await ownActiveMinistryKeys(deps, actor);
      res.json({
        timeZone: rules.timeZone,
        freeze: freezeStateAt(await dbNow(deps.db, deps.now), actor, rules),
        translationsDefault: rules.translationsDefault,
        otherCityId: rules.otherCityId,
        releaseCategoryIds: rules.releaseCategoryIds,
        required: rules.required,
        showHqCommentsField: rules.showHqCommentsField,
        showRecordsSection: rules.showRecordsSection,
        lookAheadFieldset: can.seeLookAheadFieldset(actor, rules),
        rules: editorRulesOf(rules),
        editor: {
          create: activeMinistryKeys.some((k) => can.create(actor, k)),
          relaxRequired: can.relaxRequiredFields(actor),
          useHqPlaceholder: can.useHqPlaceholder(actor),
        },
        list: {
          markup: can.seeListMarkup(actor),
          corporateQueries: can.corporateQueries(actor),
          lookAheadFilter: can.lookAheadFilter(actor),
          reviewSelected: can.reviewSelected(actor),
          clearLaStatus: can.clearLaStatus(actor),
        },
      });
    } catch (e) {
      next(e);
    }
  });
  // Any Calendar role: a read-only viewer still needs the names of the values an activity holds.
  r.get("/editor-options", async (_req, res, next) => {
    try {
      res.json(await editorOptions(deps.db));
    } catch (e) {
      next(e);
    }
  });
  return r;
}
