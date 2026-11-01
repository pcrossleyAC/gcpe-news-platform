import { Router, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { actorOf, requireAnyRole } from "@gcpe/auth";
import { getOperations } from "../operations";
import { cancelAllHeldEmail, cancelHeldEmail, HeldChangedError, NotPausedError } from "../outgoing";
import { getPurgeStatus, setPurgeEnabled } from "../purge";
import { getSoftCodesCounted, resolveBounceSummaryAddress, setBounceSummaryAddress, setSoftCodesCounted, SOFT_CODE_RE } from "../settings";
import { privateErrorsWith } from "./private-errors";
import type { SettingsRouteDeps } from "./routes";
import { NOD_ADMIN_ROLES } from "./staff-list-routes";

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const addressBody = z.object({ address: z.preprocess(blankToNull, z.union([z.string().trim().email().max(254), z.null()])) });
const softCodesBody = z.object({ codes: z.array(z.string().trim().regex(SOFT_CODE_RE)).max(50) });
const purgeBody = z.object({ enabled: z.boolean() });
/** The send jobs the screen showed and the admin confirmed (N3); a long pause's digests run to a few thousand. */
const cancelBody = z.object({ jobIds: z.array(z.string().uuid()).min(1).max(20_000) });

/** "Cancel all held email" sends what the screen showed (a fingerprint of the held jobs, when the newest was made), not every id (NC). */
const cancelAllBody = z.object({ heldKey: z.string().regex(/^[0-9a-f]{64}$/), newestAt: z.string().datetime() });

function mapError(e: unknown, res: Response): boolean {
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues }), true;
  if (e instanceof HeldChangedError) return void res.status(409).json({ error: "held-changed" }), true;
  if (e instanceof NotPausedError) return void res.status(409).json({ error: "not-paused" }), true;
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
        emergencyFeedOff: deps.emergencyFeedOff,
        testSite: deps.testSite,
        breakGlassOn: deps.breakGlassOn,
        staffPasswordsOn: deps.staffPasswordsOn,
        opsEmail: deps.opsEmail,
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

  // Held news email (N3): cancelled only while News On Demand sending is paused, and only the
  // jobs the admin was shown that are still held. Answers what it cancelled.
  r.post("/operations/held-email/cancel", admin, privateErrors(async (req, res) => {
    const { jobIds } = cancelBody.parse(req.body);
    res.json(await cancelHeldEmail(db, jobIds, actorOf(req).name));
  }));

  // Cancel all (NC): the whole held set the admin was shown, however large; refused if it changed since.
  r.post("/operations/held-email/cancel-all", admin, privateErrors(async (req, res) => {
    res.json(await cancelAllHeldEmail(db, cancelAllBody.parse(req.body), actorOf(req).name));
  }));

  return r;
}
