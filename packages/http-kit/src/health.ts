import { Router } from "express";

/**
 * One readiness dependency. It fails when it throws/rejects or resolves to exactly `false`
 * (so a synchronous flag like "is the LISTEN connection up" can be a check without throwing).
 */
export type ReadinessCheck = () => unknown;

/**
 * `GET /health/live` (always 200 while the process serves HTTP) and `GET /health/ready`
 * (200 `{status:"ok"}` only when every check passes, else 503 `{status:"unavailable"}`).
 * Check failures are never echoed to the caller — these endpoints are unauthenticated.
 */
export function healthRoutes(checks: ReadinessCheck[]): Router {
  const r = Router();
  r.get("/health/live", (_req, res) => void res.json({ status: "ok" }));
  r.get("/health/ready", async (_req, res) => {
    try {
      for (const check of checks) {
        if ((await check()) === false) throw new Error("readiness check reported unavailable");
      }
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  return r;
}
