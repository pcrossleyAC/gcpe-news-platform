import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@gcpe/db-kit";
import { priorityFor } from "./priority";
import { batches, messages } from "./db/schema";

export const messageRequestSchema = z.object({
  priority: z.enum(["system", "media", "immediate", "digest"]),
  idempotencyKey: z.string().min(1).max(200).optional(),
  subject: z.string().min(1).max(998),
  html: z.string().min(1),
  text: z.string().optional(),
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]+$/), z.string()).default({}),
  recipients: z.array(z.object({ email: z.string().email(), substitutions: z.record(z.string()).default({}) })).min(1).max(20_000),
});
export type MessageRequest = z.infer<typeof messageRequestSchema>;

export interface BatchStatus {
  id: string;
  total: number;
  pending: number;
  sent: number;
  failed: number;
}

// drizzle-orm pg-core's `.insert().values(array)` sends every row as one statement; chunking
// keeps a 20,000-recipient batch under Postgres's parameter-count and statement-size limits.
const INSERT_CHUNK_SIZE = 1_000;

/**
 * Inserts a batch and its messages in one transaction. When `idempotencyKey` is present, a
 * Postgres advisory lock scoped to `(appId, idempotencyKey)` serialises concurrent callers
 * using the same key before either one looks up or inserts the batch row, so two requests
 * racing on the same key can never both insert (the unique index on `(app_id,
 * idempotency_key)` is the backstop if the lock were ever bypassed). Without a key, every
 * call creates a new batch — Postgres's unique index allows unlimited NULL idempotency_key
 * values, so there is nothing to deduplicate against.
 */
export async function createBatch(
  db: Db,
  appId: string,
  req: MessageRequest,
  internalDomains: string[],
): Promise<{ batchId: string; created: boolean }> {
  return db.transaction(async (tx) => {
    if (req.idempotencyKey !== undefined) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${appId} || ':' || ${req.idempotencyKey}))`);
      const [existing] = await tx
        .select({ id: batches.id })
        .from(batches)
        .where(sql`${batches.appId} = ${appId} AND ${batches.idempotencyKey} = ${req.idempotencyKey}`);
      if (existing) return { batchId: existing.id, created: false };
    }

    const [batch] = await tx
      .insert(batches)
      .values({
        appId,
        idempotencyKey: req.idempotencyKey ?? null,
        subject: req.subject,
        html: req.html,
        text: req.text ?? null,
        headers: req.headers,
      })
      .returning({ id: batches.id });
    const batchId = batch!.id;

    const rows = req.recipients.map((r) => ({
      batchId,
      email: r.email,
      substitutions: r.substitutions,
      priority: priorityFor(req.priority, r.email, internalDomains),
    }));
    for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
      await tx.insert(messages).values(rows.slice(i, i + INSERT_CHUNK_SIZE));
    }

    return { batchId, created: true };
  });
}

/**
 * One query: a LEFT JOIN from `batches` so an unknown id returns zero rows (undefined)
 * rather than a zero-count row, while a batch with no messages yet still counts as 0/0/0/0.
 */
export async function batchStatus(db: Db, id: string): Promise<BatchStatus | undefined> {
  const [row] = await db
    .select({
      total: sql<string>`count(${messages.id})::int`,
      pending: sql<string>`count(*) filter (where ${messages.status} = 'pending')::int`,
      sent: sql<string>`count(*) filter (where ${messages.status} = 'sent')::int`,
      failed: sql<string>`count(*) filter (where ${messages.status} = 'failed')::int`,
    })
    .from(batches)
    .leftJoin(messages, eq(messages.batchId, batches.id))
    .where(eq(batches.id, id))
    .groupBy(batches.id);
  if (!row) return undefined;
  return { id, total: Number(row.total), pending: Number(row.pending), sent: Number(row.sent), failed: Number(row.failed) };
}
