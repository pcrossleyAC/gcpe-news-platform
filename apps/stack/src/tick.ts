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

/** A dispatcher's `{delivered, retried, dead}` (packages/events dispatchOnce). */
function isDispatchResult(v: unknown): v is { delivered: number; retried: number; dead: number } {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.delivered === "number" && typeof r.retried === "number" && typeof r.dead === "number";
}

/** "ok", or for a dispatch step that retried or gave up on deliveries, how many (suite review O1.1). */
function outcomeOf(result: unknown): string {
  if (!isDispatchResult(result) || (result.retried === 0 && result.dead === 0)) return "ok";
  return `ok: ${result.delivered} delivered, ${result.retried} to retry, ${result.dead} undelivered`;
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
            ran[step.name] = outcomeOf(await step.run());
          } catch (e) {
            ran[step.name] = `error: ${e instanceof Error ? e.message : String(e)}`;
            // Fix round 1, P2-R30 M3: a failed step is otherwise only visible in the tick
            // response's `ran` JSON — logged too, so it also reaches /stack/errors (which
            // reads back whatever console.error captured) for an operator who only has
            // SSH-less SiteGround access and didn't happen to be watching that one response.
            console.error("[stack] tick step failed", step.name, e);
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

/**
 * `Authorization: Bearer <token>` (preferred) or `?token=` (for schedulers that can only
 * issue a GET with no custom header), constant-time compared against `tickToken`.
 *
 * Fix round 1, P2-R30 M2: **POST with a `Bearer` header is the supported mode** — prefer it
 * whenever the scheduler can set a header. `?token=` is a fallback for a scheduler that can
 * only issue a bare GET: the token then lands in plaintext in the stack's own (and any
 * intermediate proxy's) access logs, which a header never does. If `?token=` is used in
 * production, rotate TICK_TOKEN on a schedule accordingly. (This belongs in Task 15's
 * operator runbook too — noted here since that doc doesn't exist yet.)
 */
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
