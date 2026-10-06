import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { escapeHtml } from "@gcpe/http-kit";
import type { DistributionClient } from "./distribution-client";
import { nodSettings, operationsLog } from "./db/schema";
import { safeErrorLabel } from "./subscribe/journeys";

export type OperationsAction = "paused" | "resumed";

export async function getSettings(db: Db): Promise<{ paused: boolean; lastDigestCutoff: string | null }> {
  const [row] = await db.select({ paused: nodSettings.paused, lastDigestCutoff: nodSettings.lastDigestCutoff }).from(nodSettings).where(eq(nodSettings.id, 1));
  return { paused: row?.paused ?? false, lastDigestCutoff: row?.lastDigestCutoff ? row.lastDigestCutoff.toISOString() : null };
}

export interface SetPausedDeps {
  db: Db;
  distribution: Pick<DistributionClient, "send">;
  /** NOD_OPS_EMAIL, resolved; null when no operator inbox is configured -- then a pause/resume
   * still writes operations_log, but no email is ever sent. */
  opsEmail: string | null;
  /** The tenant's time zone (@gcpe/config's loadTenantConfig -- Node's own tzdata, never
   * Postgres's, see the digest cutoff's own doc comment in digest.ts): the ops email's body
   * names the time of the change in this zone. Not part of the brief's original deps
   * signature -- added because the email body needs it and nothing else already threaded
   * through setPaused carries it. */
  timeZone: string;
}

function formatTenantTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "long", timeStyle: "short" }).format(at);
}

/**
 * Pauses or resumes NoD's sender (nod_settings.paused), writing one `operations_log` row and
 * emailing `opsEmail` (if set) on an actual change -- never on a repeat pause/resume (global
 * constraints: "Pausing and resuming each write operations_log and email NOD_OPS_EMAIL when
 * it is set").
 *
 * The settings update, its guard (`paused <> $paused`) and the log insert happen in one
 * transaction so a crash between them can never leave a changed setting with no log row. The
 * email send happens after that transaction commits -- a send failure must never roll back (or
 * even call into question) the setting change that already took effect, so it's logged
 * (`safeErrorLabel`, never the raw error -- no addresses/tokens/secrets in logs) and swallowed.
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
    const [log] = await tx.insert(operationsLog).values({ actor, action }).returning({ id: operationsLog.id, at: operationsLog.at });
    return log!;
  });
  if (!logged) return { changed: false };

  if (deps.opsEmail) {
    const when = formatTenantTime(logged.at, deps.timeZone);
    const subject = `BC Gov News On Demand sending ${action}`;
    const bodyText = `${actor} ${action} BC Gov News On Demand sending at ${when} (${deps.timeZone}).`;
    try {
      await deps.distribution.send({
        priority: "system",
        idempotencyKey: `nod-ops-${logged.id}`,
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
      console.error(`[nod] ops email ${logged.id} (${action}) failed: ${safeErrorLabel(e)}`);
    }
  }
  return { changed: true };
}
