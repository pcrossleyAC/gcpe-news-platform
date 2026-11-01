import express, { Router } from "express";
import { z } from "zod";
import { requireBearer, requireRole } from "@gcpe/auth";
import type { OutboxAdmin, UndeliveredList } from "@gcpe/events";

/**
 * Suite review O1.3 (owner 2026-10-31): the Hub's Undelivered updates screen, Core.Admin only —
 * every app's outbox in one list (the Calendar's own SysAdmin page stays as it is):
 *
 * - `GET /stack/undelivered`: `{ apps: [{ app, items, total, truncated }] }`, one entry per app
 *   with an outbox, newest first within each, never a payload;
 * - `POST /stack/undelivered/retry` `{ app, eventId, subscriber }`: 204, or 404 when that one is
 *   no longer undelivered (already retried or delivered);
 * - `POST /stack/undelivered/retry-all` `{ app }`: `{ retried }`, how many went back in the queue.
 */
export function undeliveredRouter(auth: Parameters<typeof requireBearer>[0], outboxes: { name: string; outbox: OutboxAdmin }[]): Router {
  const byName = new Map(outboxes.map((o) => [o.name, o.outbox]));
  const appName = z.string().refine((n) => byName.has(n), "unknown app");
  const retryOne = z.object({ app: appName, eventId: z.string().uuid(), subscriber: z.string().min(1).max(100) }).strict();
  const retryAll = z.object({ app: appName }).strict();

  const r = Router();
  r.use("/undelivered", requireBearer(auth), requireRole("Core.Admin"), express.json({ limit: "4kb" }));
  r.get("/undelivered", async (_req, res, next) => {
    try {
      const apps: ({ app: string } & UndeliveredList)[] = await Promise.all(outboxes.map(async (o) => ({ app: o.name, ...(await o.outbox.list()) })));
      res.json({ apps });
    } catch (e) {
      next(e);
    }
  });
  r.post("/undelivered/retry", async (req, res, next) => {
    const b = retryOne.safeParse(req.body);
    if (!b.success) return void res.status(400).json({ error: "invalid request" });
    try {
      if (!(await byName.get(b.data.app)!.retry(b.data.eventId, b.data.subscriber))) return void res.status(404).json({ error: "not found" });
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });
  r.post("/undelivered/retry-all", async (req, res, next) => {
    const b = retryAll.safeParse(req.body);
    if (!b.success) return void res.status(400).json({ error: "invalid request" });
    try {
      res.json({ retried: await byName.get(b.data.app)!.retryAll() });
    } catch (e) {
      next(e);
    }
  });
  return r;
}
