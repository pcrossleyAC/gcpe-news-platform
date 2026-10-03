import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { enqueueEvent, termEventType, termRecordSchema, type SubscriberConfig, type TermKind, type TermRecord } from "@gcpe/events";
import { terms } from "../db/schema";

export const termInputSchema = termRecordSchema.omit({ updatedAt: true });
export type TermInput = Omit<TermRecord, "updatedAt">;

type Row = typeof terms.$inferSelect;

export function toTermRecord(row: Row): TermRecord {
  return {
    kind: row.kind,
    key: row.key,
    displayName: row.displayName,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    social: row.social,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function upsertTerm(
  db: Db,
  input: TermInput,
  subscribers: SubscriberConfig[],
  opts: { legacyId?: string } = {},
): Promise<{ record: TermRecord; changed: boolean }> {
  const data = termInputSchema.parse(input);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${data.kind}:${data.key}`}))`);
    const [existing] = await tx
      .select()
      .from(terms)
      .where(and(eq(terms.kind, data.kind), eq(terms.key, data.key)))
      .for("update");
    if (existing) {
      const { updatedAt: _u, ...current } = toTermRecord(existing);
      if (JSON.stringify(termInputSchema.parse(current)) === JSON.stringify(data)) {
        return { record: toTermRecord(existing), changed: false };
      }
    }
    const values = { ...data, legacyId: opts.legacyId ?? existing?.legacyId ?? null, updatedAt: new Date() };
    const [row] = await tx
      .insert(terms)
      .values(values)
      .onConflictDoUpdate({ target: [terms.kind, terms.key], set: values })
      .returning();
    const record = toTermRecord(row!);
    await enqueueEvent(
      tx,
      { type: termEventType(record.kind, "upserted"), source: "core", aggregateId: `${record.kind}:${record.key}`, data: record },
      subscribers,
    );
    return { record, changed: true };
  });
}

export async function deactivateTerm(db: Db, kind: TermKind, key: string, subscribers: SubscriberConfig[]): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${kind}:${key}`}))`);
    const [existing] = await tx
      .select()
      .from(terms)
      .where(and(eq(terms.kind, kind), eq(terms.key, key)))
      .for("update");
    if (!existing) return false;
    if (!existing.isActive) return true;
    await tx
      .update(terms)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(terms.kind, kind), eq(terms.key, key)));
    await enqueueEvent(tx, { type: termEventType(kind, "deactivated"), source: "core", aggregateId: `${kind}:${key}`, data: { kind, key } }, subscribers);
    return true;
  });
}

export async function listTerms(db: Db, kind: TermKind): Promise<TermRecord[]> {
  const rows = await db.select().from(terms).where(eq(terms.kind, kind)).orderBy(asc(terms.sortOrder), asc(terms.key));
  return rows.map(toTermRecord);
}

export async function getTerm(db: Db, kind: TermKind, key: string): Promise<TermRecord | null> {
  const [row] = await db.select().from(terms).where(and(eq(terms.kind, kind), eq(terms.key, key)));
  return row ? toTermRecord(row) : null;
}
