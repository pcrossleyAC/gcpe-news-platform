import { and, eq, ne, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import { escapeHtml } from "@gcpe/http-kit";
import type { DistributionClient } from "./distribution-client";
import { nodSettings, operationsLog } from "./db/schema";
import { safeErrorLabel } from "./subscribe/journeys";

export type OperationsAction = "paused" | "resumed" | "distribution-paused" | "distribution-resumed";

export async function getSettings(db: Db): Promise<{ paused: boolean; lastDigestCutoff: string | null }> {
  const [row] = await db.select({ paused: nodSettings.paused, lastDigestCutoff: nodSettings.lastDigestCutoff }).from(nodSettings).where(eq(nodSettings.id, 1));
  return { paused: row?.paused ?? false, lastDigestCutoff: row?.lastDigestCutoff ? row.lastDigestCutoff.toISOString() : null };
}

interface OpsEmailDeps {
  distribution: Pick<DistributionClient, "send">;
  /** NOD_OPS_EMAIL, resolved; null when no operator inbox is configured -- then a change
   * still writes operations_log, but no email is ever sent. */
  opsEmail: string | null;
  /** The tenant's time zone (@gcpe/config's loadTenantConfig -- Node's own tzdata, never
   * Postgres's, see the digest cutoff's own doc comment in digest.ts): the ops email's body
   * names the time of the change in this zone. */
  timeZone: string;
}

function formatTenantTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "long", timeStyle: "short" }).format(at);
}

/** Writes one `operations_log` row for `action` by `actor` -- callable inside an existing
 * transaction (NoD's own setPaused) or standalone (setDistributionPaused, below, which has no
 * local settings row of its own to update atomically with it). */
async function writeOpsLog(dbOrTx: DbOrTx, actor: string, action: OperationsAction): Promise<{ id: string; at: Date }> {
  const [log] = await dbOrTx.insert(operationsLog).values({ actor, action }).returning({ id: operationsLog.id, at: operationsLog.at });
  return log!;
}

/**
 * Emails `deps.opsEmail` (if configured) that `actor` just `verb` `noun` (e.g. "paused BC Gov
 * News On Demand sending" / "paused BC Gov News On Demand distribution") -- a best-effort,
 * system-priority notice sent through Distribution itself (so it goes out even while
 * Distribution is paused: the claim's pause filter only excludes sub-system priority). A send
 * failure is logged (`safeErrorLabel`, never the raw error -- no addresses/tokens/secrets in
 * logs) and swallowed, never undoing the change this is reporting on.
 */
async function emailOpsChange(deps: OpsEmailDeps, log: { id: string; at: Date }, actor: string, action: OperationsAction, verb: "paused" | "resumed", noun: string): Promise<void> {
  if (!deps.opsEmail) return;
  const when = formatTenantTime(log.at, deps.timeZone);
  const subject = `${noun} ${verb}`;
  const bodyText = `${actor} ${verb} ${noun} at ${when} (${deps.timeZone}).`;
  try {
    await deps.distribution.send({
      priority: "system",
      idempotencyKey: `nod-ops-${log.id}`,
      subject,
      html: `<p>${escapeHtml(bodyText)}</p>`,
      text: bodyText,
      headers: {},
      recipients: [{ email: deps.opsEmail, substitutions: {} }],
    });
  } catch (e) {
    // Never the raw error/message: see journeys.ts's safeErrorLabel doc comment -- a
    // DrizzleQueryError or DistributionError's message can carry bound values (here, at
    // most the ops address itself, which logs must never carry either).
    console.error(`[nod] ops email ${log.id} (${action}) failed: ${safeErrorLabel(e)}`);
  }
}

export interface SetPausedDeps extends OpsEmailDeps {
  db: Db;
}

/**
 * Pauses or resumes NoD's own sender (nod_settings.paused), writing one `operations_log` row
 * and emailing `opsEmail` (if set) on an actual change -- never on a repeat pause/resume
 * (global constraints: "Pausing and resuming each write operations_log and email
 * NOD_OPS_EMAIL when it is set").
 *
 * The settings update, its guard (`paused <> $paused`) and the log insert happen in one
 * transaction so a crash between them can never leave a changed setting with no log row. The
 * email send happens after that transaction commits -- a send failure must never roll back (or
 * even call into question) the setting change that already took effect.
 */
export async function setPaused(deps: SetPausedDeps, paused: boolean, actor: string): Promise<{ changed: boolean }> {
  const action: OperationsAction = paused ? "paused" : "resumed";

  const logged = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(nodSettings)
      .set({ paused, updatedAt: sql`now()` })
      .where(and(eq(nodSettings.id, 1), ne(nodSettings.paused, paused)))
      .returning({ id: nodSettings.id });
    if (!row) return null; // already in the requested state -- no log, no email
    return writeOpsLog(tx, actor, action);
  });
  if (!logged) return { changed: false };

  await emailOpsChange(deps, logged, actor, action, paused ? "paused" : "resumed", "BC Gov News On Demand sending");
  return { changed: true };
}

export interface SetDistributionPausedDeps extends OpsEmailDeps {
  db: Db;
  distribution: Pick<DistributionClient, "send" | "setPaused">;
}

/**
 * Pauses or resumes *Distribution*, staff-controlled through NoD's own `NoD.Admin`-gated
 * routes (apps/nod/src/http/routes.ts) -- the same admin surface as NoD's own pause above,
 * just for Distribution's state instead of NoD's.
 *
 * Distribution's own `paused` flag is authoritative and lives over there (its
 * `distribution_settings` row), reached over HTTP through `deps.distribution.setPaused` --
 * there is no local row here to update transactionally with the log, unlike setPaused above, so
 * a crash between the two calls below just leaves the Distribution-side change made without an
 * audit row rather than something unrecoverable. A Distribution error (network, 5xx, 401/403,
 * ...) propagates as-is (a DistributionError) and nothing is written or emailed -- there is
 * nothing to log, since nothing actually changed.
 */
export async function setDistributionPaused(deps: SetDistributionPausedDeps, paused: boolean, actor: string): Promise<{ paused: boolean; changed: boolean }> {
  const result = await deps.distribution.setPaused(paused);
  if (!result.changed) return result;

  const action: OperationsAction = paused ? "distribution-paused" : "distribution-resumed";
  const logged = await writeOpsLog(deps.db, actor, action);
  await emailOpsChange(deps, logged, actor, action, paused ? "paused" : "resumed", "BC Gov News On Demand distribution");
  return result;
}
