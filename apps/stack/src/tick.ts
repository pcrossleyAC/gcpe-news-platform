import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";

export interface TickStep {
  /** Reported back verbatim as a key of the `ran` object. */
  name: string;
  run: () => Promise<unknown>;
}

export interface TickRunResult {
  ran: Record<string, string>;
  ms: number;
}

export interface TickRunner {
  /** True while a run() is in flight (for tests; the router itself never polls this —
   * run() already returns {skipped:true} atomically instead of racing against it). */
  readonly running: boolean;
  run(): Promise<{ skipped: true } | ({ skipped: false } & TickRunResult)>;
}

/**
 * Runs `steps` strictly in order, each in its own try/catch (one step's failure never stops
 * the rest), and coalesces overlapping calls: a call that arrives while a previous one is
 * still running returns `{skipped:true}` immediately instead of queueing or running
 * concurrently. Safe without a lock/mutex because the `running` flag is set synchronously,
 * before the first `await` in `run()` — no other code can run between the check and the set
 * in Node's single-threaded event loop.
 */
export function createTickRunner(steps: TickStep[]): TickRunner {
  let running = false;
  return {
    get running() {
      return running;
    },
    async run() {
      if (running) return { skipped: true as const };
      running = true;
      try {
        const start = Date.now();
        const ran: Record<string, string> = {};
        for (const step of steps) {
          try {
            await step.run();
            ran[step.name] = "ok";
          } catch (e) {
            ran[step.name] = `error: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
        return { skipped: false as const, ran, ms: Date.now() - start };
      } finally {
        running = false;
      }
    },
  };
}

/** Hashes both sides to a fixed-length digest before comparing, so a mismatch's timing never
 * reveals how many of the provided token's characters happened to be right or how long it
 * was relative to the real one. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** `Authorization: Bearer <token>` (preferred) or `?token=` (for schedulers that can only
 * issue a GET with no custom header), constant-time compared against `tickToken`. */
export function requireTickToken(tickToken: string): RequestHandler {
  return (req, res, next) => {
    const header = req.header("authorization");
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
    const provided = bearer ?? queryToken;
    if (!provided || !safeEqual(provided, tickToken)) return void res.status(401).json({ error: "invalid token" });
    next();
  };
}

/** Mounts GET and POST /tick (both accepted — a scheduler that can only GET still works)
 * behind {@link requireTickToken}. */
export function tickRouter(tickToken: string, runner: TickRunner): Router {
  const r = Router();
  const handler: RequestHandler = async (_req, res) => {
    const result = await runner.run();
    if (result.skipped) return void res.status(202).json({ skipped: true });
    res.status(200).json({ ran: result.ran, ms: result.ms });
  };
  r.get("/tick", requireTickToken(tickToken), handler);
  r.post("/tick", requireTickToken(tickToken), handler);
  return r;
}
