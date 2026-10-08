import { Router } from "express";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { requireBearer, requireRole, type BearerOptions } from "@gcpe/auth";
import { safeErrorLabel } from "@gcpe/http-kit";

/** Temporary: runs the report-rendering spike from DATA_DIR inside the app runtime. Core.Admin only. Never merged. */
export function spikeRouter(auth: BearerOptions, dataDir: string): Router {
  const r = Router();
  r.post("/spike/report", requireBearer(auth), requireRole("Core.Admin"), async (req, res) => {
    try {
      const mod = (await import(pathToFileURL(join(dataDir, "spike", "run-all.mjs")).href)) as { runAll(o: object): Promise<unknown> };
      const only = typeof req.query.only === "string" ? req.query.only.split(",") : null;
      res.json(await mod.runAll({ host: "siteground-runtime", outDir: join(dataDir, "spike", "out", "siteground-runtime"), repeat: 3, only }));
    } catch (e) {
      console.error("[stack] spike failed", safeErrorLabel(e));
      res.status(500).json({ error: safeErrorLabel(e) });
    }
  });
  return r;
}
