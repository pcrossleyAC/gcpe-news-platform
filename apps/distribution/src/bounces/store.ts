import { and, desc, eq, sql } from "drizzle-orm";
import { sqlInterval, type Tx } from "@gcpe/db-kit";
import { batches, bounces, messages } from "../db/schema";
import type { ParsedBounce } from "./parse";

export interface RecordBounceResult {
  bounceId: string;
  matched: { messageId: string; batchId: string; appId: string; email: string } | null;
  duplicate: boolean;
}

// Matching §2's fallback window (Global Constraints "Matching"): a bounce with no usable
// Message-ID is matched to the most recent `sent` message to the same recipient, as long as it
// was sent within this many days of the bounce being recorded.
const RECIPIENT_FALLBACK_WINDOW_MS = 4 * 24 * 3_600_000;

type MatchRow = { id: string; batchId: string; appId: string; email: string; bounceHard: boolean | null };

/** Both sides of a Message-ID comparison are normalised the same way: Distribution's own
 * stored value always carries angle brackets (sender.ts's messageIdFor), but a bounce report
 * may give it with or without them, and with surrounding whitespace. */
function normalizeMessageId(id: string): string {
  return id.trim().replace(/^</, "").replace(/>$/, "").trim();
}

async function findMatch(tx: Tx, parsed: ParsedBounce & { kind: "bounce" }): Promise<MatchRow | null> {
  const matchColumns = { id: messages.id, batchId: messages.batchId, appId: batches.appId, email: messages.email, bounceHard: messages.bounceHard };

  if (parsed.originalMessageId) {
    const wrapped = `<${normalizeMessageId(parsed.originalMessageId)}>`;
    const [row] = await tx
      .select(matchColumns)
      .from(messages)
      .innerJoin(batches, eq(batches.id, messages.batchId))
      .where(eq(messages.messageId, wrapped));
    if (row) return row;
  }

  // Fallback (Global Constraints "Matching" §2): no Message-ID, or it matched nothing — the
  // most recent `sent` message to this recipient, case-insensitively, within the window.
  const [row] = await tx
    .select(matchColumns)
    .from(messages)
    .innerJoin(batches, eq(batches.id, messages.batchId))
    .where(
      and(
        eq(messages.status, "sent"),
        sql`lower(${messages.email}) = lower(${parsed.recipient})`,
        sql`${messages.sentAt} >= now() - ${sqlInterval(RECIPIENT_FALLBACK_WINDOW_MS)}`,
        sql`${messages.sentAt} <= now()`,
      ),
    )
    .orderBy(desc(messages.sentAt))
    .limit(1);
  return row ?? null;
}

/**
 * Records one fetched bounce report, matches it to the message it's about, and updates that
 * message's bounce columns — all inside the caller's transaction, so a caller that also emits
 * `delivery.bounced` (4e Task 2) does so atomically with this write.
 *
 * A duplicate `sourceId` (the same bounce fetched twice) is detected by the table's own unique
 * index rather than a separate check-then-insert, so it's race-free: nothing else happens, and
 * the existing row's id is returned.
 *
 * The recipient reported back is always the message's own `email` (its intended recipient),
 * never a redirect address — matching is what finds the message; the message already knows who
 * it was meant for.
 */
export async function recordBounce(tx: Tx, sourceId: string, raw: string, parsed: ParsedBounce): Promise<RecordBounceResult> {
  const matched = parsed.kind === "bounce" ? await findMatch(tx, parsed) : null;

  const [inserted] = await tx
    .insert(bounces)
    .values({
      sourceId,
      raw,
      kind: parsed.kind,
      recipient: parsed.kind === "bounce" ? parsed.recipient : null,
      status: parsed.kind === "bounce" ? parsed.status : null,
      hard: parsed.kind === "bounce" ? parsed.hard : null,
      method: parsed.kind === "bounce" ? parsed.method : null,
      messageId: matched?.id ?? null,
      matched: matched !== null,
      processedAt: sql`now()`,
    })
    .onConflictDoNothing({ target: bounces.sourceId })
    .returning({ id: bounces.id });

  if (!inserted) {
    const [existing] = await tx.select({ id: bounces.id }).from(bounces).where(eq(bounces.sourceId, sourceId));
    // Defensive: the row this conflicted against must exist (the unique index is what caused
    // the conflict), so an empty result here would mean it was deleted between the conflict
    // and this read — nothing in this schema ever deletes a bounce row, so this should be
    // unreachable.
    if (!existing) throw new Error(`recordBounce: source_id ${sourceId} conflicted on insert but no existing row was found`);
    return { bounceId: existing.id, matched: null, duplicate: true };
  }

  // A hard bounce is never downgraded back to soft: once a message's bounce columns record
  // one, a later bounce for the same message leaves them untouched (this bounce's own row is
  // still recorded and matched above, regardless).
  if (matched && parsed.kind === "bounce" && !matched.bounceHard) {
    await tx.update(messages).set({ bouncedAt: sql`now()`, bounceStatus: parsed.status, bounceHard: parsed.hard }).where(eq(messages.id, matched.id));
  }

  return {
    bounceId: inserted.id,
    matched: matched ? { messageId: matched.id, batchId: matched.batchId, appId: matched.appId, email: matched.email } : null,
    duplicate: false,
  };
}
