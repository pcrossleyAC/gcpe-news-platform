import express, { Router } from "express";
import { z } from "zod";
import { actorOf, requireBearer, requireRole } from "@gcpe/auth";
import type { OutboxAdmin, UndeliveredList, UndeliveredUpdate } from "@gcpe/events";
import type { Dismissal } from "../../core/src/services/outbox-dismissals";

/** Who dismissed which update: Core's record (apps/core/src/services/outbox-dismissals.ts). */
export interface DismissalRecords {
  record(app: string, updates: UndeliveredUpdate[], actor: { id: string; name: string }): Promise<void>;
  recent(limit: number): Promise<Dismissal[]>;
}

/** Why a replaced update is refused (fix round 1, I1); the Calendar's route says the same. */
export const REPLACED_MESSAGE = "A newer update replaced this one, so it isn't sent again.";

/** How many recent dismissals the screen lists. */
export const RECENT_DISMISSALS = 50;

/**
 * Suite review O1.3 (owner 2026-10-31): the Hub's Undelivered updates screen, Core.Admin only —
 * every app's outbox in one list (the Calendar's own SysAdmin page stays as it is):
 *
 * - `GET /stack/undelivered`: `{ apps: [{ app, items, total, replaced, truncated }], dismissed }`,
 *   one entry per app with an outbox, newest first within each, never a payload; `dismissed` is the
 *   most recent dismissals, newest first, with who and when;
 * - `POST /stack/undelivered/retry` `{ app, eventId, subscriber }`: 204; 409 when a newer update for
 *   the same record replaced it (never resent: fix round 1, I1); 404 when it is no longer undelivered;
 * - `POST /stack/undelivered/retry-all` `{ app }`: `{ retried, replaced }` — the replaced ones skipped;
 * - `POST /stack/undelivered/dismiss` `{ app, eventId, subscriber }`: 204, or 404 (fix round 1, M1);
 * - `POST /stack/undelivered/dismiss-all` `{}`: `{ dismissed }`, every app's undelivered updates.
 */
export function undeliveredRouter(auth: Parameters<typeof requireBearer>[0], outboxes: { name: string; outbox: OutboxAdmin }[], dismissals: DismissalRecords): Router {
  const byName = new Map(outboxes.map((o) => [o.name, o.outbox]));
  const appName = z.string().refine((n) => byName.has(n), "unknown app");
  const oneSchema = z.object({ app: appName, eventId: z.string().uuid(), subscriber: z.string().min(1).max(100) }).strict();
  const appSchema = z.object({ app: appName }).strict();
  const noneSchema = z.object({}).strict();

  const r = Router();
  r.use("/undelivered", requireBearer(auth), requireRole("Core.Admin"), express.json({ limit: "4kb" }));
  r.get("/undelivered", async (_req, res, next) => {
    try {
      const [apps, dismissed] = await Promise.all([
        Promise.all(outboxes.map(async (o): Promise<{ app: string } & UndeliveredList> => ({ app: o.name, ...(await o.outbox.list()) }))),
        dismissals.recent(RECENT_DISMISSALS),
      ]);
      res.json({ apps, dismissed });
    } catch (e) {
      next(e);
    }
  });
  r.post("/undelivered/retry", async (req, res, next) => {
    const b = oneSchema.safeParse(req.body);
    if (!b.success) return void res.status(400).json({ error: "invalid request" });
    try {
      const outcome = await byName.get(b.data.app)!.retry(b.data.eventId, b.data.subscriber);
      if (outcome === "replaced") return void res.status(409).json({ error: REPLACED_MESSAGE });
      if (outcome === "not-found") return void res.status(404).json({ error: "not found" });
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });
  r.post("/undelivered/retry-all", async (req, res, next) => {
    const b = appSchema.safeParse(req.body);
    if (!b.success) return void res.status(400).json({ error: "invalid request" });
    try {
      res.json(await byName.get(b.data.app)!.retryAll());
    } catch (e) {
      next(e);
    }
  });
  r.post("/undelivered/dismiss", async (req, res, next) => {
    const b = oneSchema.safeParse(req.body);
    if (!b.success) return void res.status(400).json({ error: "invalid request" });
    try {
      const done = await byName.get(b.data.app)!.dismiss(b.data.eventId, b.data.subscriber);
      if (!done) return void res.status(404).json({ error: "not found" });
      await dismissals.record(b.data.app, [done], actorOf(req));
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });
  r.post("/undelivered/dismiss-all", async (req, res, next) => {
    const b = noneSchema.safeParse(req.body ?? {});
    if (!b.success) return void res.status(400).json({ error: "invalid request" });
    try {
      const actor = actorOf(req);
      let dismissed = 0;
      for (const o of outboxes) {
        const done = await o.outbox.dismissAll();
        await dismissals.record(o.name, done, actor);
        dismissed += done.length;
      }
      res.json({ dismissed });
    } catch (e) {
      next(e);
    }
  });
  return r;
}
