import { and, desc, eq, sql } from "drizzle-orm";
import { sqlInterval, type Tx } from "@gcpe/db-kit";
import { enqueueEvent, type SubscriberConfig } from "@gcpe/events";
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

/** Splits a normalised Message-ID into its local part (the row id — kept exactly as given) and
 * its domain (matched case-insensitively below, per RFC 5321/5322: domains are
 * case-insensitive, unlike the local part). Null when there's no usable "local@domain" shape —
 * no '@', or an empty side — so callers can fall through to the recipient fallback instead. */
function splitMessageId(id: string): { local: string; domain: string } | null {
  const bare = normalizeMessageId(id);
  const at = bare.lastIndexOf("@");
  if (at <= 0 || at === bare.length - 1) return null;
  return { local: bare.slice(0, at), domain: bare.slice(at + 1) };
}

// sender.ts's messageIdFor always derives the local part from the row's own uuid primary key —
// a local part that isn't shaped like one was never ours, so it's never looked up as a primary
// key (and never falls through to a scan of `messages` either; see findMatch below).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Message-ID match (Global Constraints "Matching" §1), then the recipient fallback (§2).
 *
 * The Message-ID's local part *is* the matched message's own row id (sender.ts's
 * messageIdFor), so a usable one is looked up by primary key — `messages.id = $local::uuid` —
 * instead of a string split-and-compare over every row, which a large `messages` table (final
 * review: ~500ms at 2M rows) turned into a sequential scan. A local part that isn't uuid-shaped
 * never reaches the database at all: it was never one of ours, so there's nothing to look up.
 * The found row's own domain is still compared case-insensitively against the bounce's parsed
 * one, exactly as the old string comparison did.
 *
 * Ruling (final review): the recipient fallback below runs only for a bounce that could
 * plausibly be naming one of ours — no Message-ID at all, or one on our own domain
 * (`messageIdDomain`) that simply didn't resolve to a row (purged, or a race). A Message-ID on a
 * foreign domain (legacy's, or another system's, during a parallel run) never named a message
 * we sent, so it's left unmatched rather than pinned onto an unrelated recent send to the same
 * recipient. A Message-ID that's *present but unparseable* (no '@' at all, or nothing on one
 * side of it) is treated the same way as foreign, not the same as no Message-ID at all: it
 * names something, just not in the "local@domain" shape ours always has, so there's no basis
 * for treating it as "go ahead and check the recipient instead".
 */
async function findMatch(tx: Tx, parsed: ParsedBounce & { kind: "bounce" }, messageIdDomain: string): Promise<MatchRow | null> {
  const matchColumns = { id: messages.id, batchId: messages.batchId, appId: batches.appId, email: messages.email, bounceHard: messages.bounceHard };

  const hasMessageId = parsed.originalMessageId !== null;
  const parts = hasMessageId ? splitMessageId(parsed.originalMessageId!) : null;

  if (parts && UUID_RE.test(parts.local)) {
    const [row] = await tx
      .select({ ...matchColumns, messageId: messages.messageId })
      .from(messages)
      .innerJoin(batches, eq(batches.id, messages.batchId))
      .where(eq(messages.id, parts.local));
    const rowDomain = row?.messageId ? splitMessageId(row.messageId)?.domain : undefined;
    if (row && rowDomain !== undefined && rowDomain.toLowerCase() === parts.domain.toLowerCase()) {
      return { id: row.id, batchId: row.batchId, appId: row.appId, email: row.email, bounceHard: row.bounceHard };
    }
  }

  if (hasMessageId && (!parts || parts.domain.toLowerCase() !== messageIdDomain.toLowerCase())) return null;

  // Fallback (Global Constraints "Matching" §2): no Message-ID, or it's one of ours that
  // matched nothing — the most recent `sent` message to this recipient, case-insensitively,
  // within the window.
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

/** Postgres `text` columns reject an embedded NUL outright, and bounce content is externally
 * controlled (an upload, or whatever a mailbox handed back) — stripped from every text value
 * this module stores, rather than trusting the source (or the earlier upload route) to have
 * done it already. */
function stripNul(s: string): string {
  return s.includes("\u0000") ? s.replaceAll("\u0000", "") : s;
}

/**
 * Records one fetched bounce report, matches it to the message it's about, and updates that
 * message's bounce columns — all inside the caller's transaction. When the bounce matched (and
 * wasn't a duplicate), a `delivery.bounced` event is enqueued to the same outbox, in the same
 * transaction, so the record and the notification are atomic: either both happen or neither
 * does. `subscribers` is passed straight through to {@link enqueueEvent}; an empty list still
 * records the outbox event, it just queues no deliveries.
 *
 * A duplicate `sourceId` (the same bounce fetched twice) is detected by the table's own unique
 * index rather than a separate check-then-insert, so it's race-free: nothing else happens, and
 * the existing row's id is returned.
 *
 * The recipient reported back is always the message's own `email` (its intended recipient),
 * never a redirect address — matching is what finds the message; the message already knows who
 * it was meant for.
 *
 * `messageIdDomain` is env.ts's own resolved `MESSAGE_ID_DOMAIN` — what makes a Message-ID
 * "ours" for the recipient-fallback gate inside {@link findMatch}.
 */
export async function recordBounce(
  tx: Tx,
  sourceId: string,
  raw: string,
  parsed: ParsedBounce,
  subscribers: SubscriberConfig[],
  messageIdDomain: string,
): Promise<RecordBounceResult> {
  // Stripped once, up front: `parsed`'s own text fields feed both the match query below (a NUL
  // byte in a bound parameter is itself rejected by Postgres, not just by storing it) and the
  // insert further down, so both need the clean value, not just the one that's stored.
  const clean: ParsedBounce =
    parsed.kind === "bounce" ? { ...parsed, recipient: stripNul(parsed.recipient), status: stripNul(parsed.status) } : parsed;

  const matched = clean.kind === "bounce" ? await findMatch(tx, clean, messageIdDomain) : null;

  const [inserted] = await tx
    .insert(bounces)
    .values({
      sourceId,
      raw: stripNul(raw),
      kind: clean.kind,
      recipient: clean.kind === "bounce" ? clean.recipient : null,
      status: clean.kind === "bounce" ? clean.status : null,
      hard: clean.kind === "bounce" ? clean.hard : null,
      method: clean.kind === "bounce" ? clean.method : null,
      messageId: matched?.id ?? null,
      matched: matched !== null,
      processedAt: sql`now()`,
    })
    .onConflictDoNothing({ target: bounces.sourceId })
    .returning({ id: bounces.id, processedAt: bounces.processedAt });

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

  // The event only fires for a matched, non-duplicate bounce -- an unmatched or ignored report
  // has nothing for the originating app to act on, and a duplicate never gets here (its own
  // early return above skips straight past this). Same transaction as the row above it, so the
  // two commit or roll back together.
  if (matched && parsed.kind === "bounce") {
    await enqueueEvent(
      tx,
      {
        type: "delivery.bounced",
        source: "distribution",
        aggregateId: `message:${matched.id}`,
        data: {
          appId: matched.appId,
          batchId: matched.batchId,
          messageId: matched.id,
          email: matched.email,
          hard: parsed.hard,
          status: parsed.status,
          at: inserted.processedAt!.toISOString(),
        },
      },
      subscribers,
    );
  }

  return {
    bounceId: inserted.id,
    matched: matched ? { messageId: matched.id, batchId: matched.batchId, appId: matched.appId, email: matched.email } : null,
    duplicate: false,
  };
}
