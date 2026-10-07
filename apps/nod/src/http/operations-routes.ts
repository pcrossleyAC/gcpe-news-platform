import { Router, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { actorOf, requireAnyRole } from "@gcpe/auth";
import { getOperations } from "../operations";
import { getPurgeStatus, setPurgeEnabled } from "../purge";
import { getSoftCodesCounted, resolveBounceSummaryAddress, setBounceSummaryAddress, setSoftCodesCounted, SOFT_CODE_RE } from "../settings";
import { privateErrorsWith } from "./private-errors";
import type { SettingsRouteDeps } from "./routes";
import { NOD_ADMIN_ROLES } from "./staff-list-routes";

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const addressBody = z.object({ address: z.preprocess(blankToNull, z.union([z.string().trim().email().max(254), z.null()])) });
const softCodesBody = z.object({ codes: z.array(z.string().trim().regex(SOFT_CODE_RE)).max(50) });
const purgeBody = z.object({ enabled: z.boolean() });

function mapError(e: unknown, res: Response): boolean {
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues }), true;
  return false;
}
/** The summary address is bound in these queries (see private-errors.ts). */
const privateErrors = privateErrorsWith(mapError, "operations request");

/** Spec §8 Operations, NoD.Admin only. Pause/resume keep their existing routes
 * (/settings/*, /distribution/*); this adds the combined read and the summary address. */
export function operationsRoutes(db: Db, deps: SettingsRouteDeps): Router {
  const r = Router();
  const admin = requireAnyRole(...NOD_ADMIN_ROLES);

  r.get("/operations", admin, privateErrors(async (_req, res) => {
    res.json(
      await getOperations(db, deps.distribution, {
        bounceSummaryFallback: deps.bounceSummaryFallback,
        timeZone: deps.timeZone,
        emergencyFeedUrl: deps.emergencyFeedUrl,
      }),
    );
  }));

  r.put("/operations/bounce-summary-address", admin, privateErrors(async (req, res) => {
    const { address } = addressBody.parse(req.body);
    const { changed } = await setBounceSummaryAddress(db, address, actorOf(req).name);
    res.json({ changed, bounceSummary: await resolveBounceSummaryAddress(db, deps.bounceSummaryFallback) });
  }));

  r.put("/operations/bounce-soft-codes", admin, privateErrors(async (req, res) => {
    const { codes } = softCodesBody.parse(req.body);
    const { changed } = await setSoftCodesCounted(db, codes, actorOf(req).name);
    res.json({ changed, softCodesCounted: await getSoftCodesCounted(db) });
  }));

  // The retention purge switch (spec §9, Q25). Turning it on is logged with what it would
  // remove at that moment; the nightly run then deletes for good.
  r.put("/operations/purge", admin, privateErrors(async (req, res) => {
    const { enabled } = purgeBody.parse(req.body);
    const { changed } = await setPurgeEnabled(db, enabled, actorOf(req).name);
    res.json({ changed, purge: await getPurgeStatus(db, deps.timeZone) });
  }));

  return r;
}
