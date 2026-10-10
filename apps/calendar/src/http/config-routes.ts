import { Router } from "express";
import { can } from "../capabilities";
import { freezeStateAt } from "../freeze";
import { dbNow } from "../time";
import type { ApiDeps } from "./routes";

/** What the list and the editor need from the tenant's calendar section, and the freeze as it
 * stands for the caller (spec addendum §7.4: the standing banner and the read-only editor). */
export function configRoutes(deps: ApiDeps): Router {
  const r = Router();
  r.get("/config", async (req, res, next) => {
    try {
      const actor = req.calendar!;
      const { rules } = deps;
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
  return r;
}
