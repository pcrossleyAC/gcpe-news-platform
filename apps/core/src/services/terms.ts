import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { enqueueEvent, termEventType, termRecordSchema, type SubscriberConfig, type TermKind, type TermRecord } from "@gcpe/events";
import { terms } from "../db/schema";
import { sameLegacyExtras, type LegacyExtras } from "./legacy-extras";
import { CORE_SOURCE, lockAggregate, termAggregateId } from "./aggregate";
import { recordAudit, type AuditActor } from "./audit";

const termEntry = (kind: TermKind, key: string, label: string | null, action: string, details: Record<string, unknown> = {}) => ({
  action,
  targetType: "term" as const,
  targetId: `${kind}:${key}`,
  targetLabel: label ?? key,
  details: { kind, ...details },
});

export const termInputSchema = termRecordSchema.omit({ updatedAt: true });
export type TermInput = Omit<TermRecord, "updatedAt">;

/** A new term's key: what the public site's CATEGORY_KEY accepts (apps/public-site/src/site-paths.ts). Existing legacy keys are exempt. */
export const NEW_TERM_KEY = /^[a-z0-9-]{1,100}$/;
export const TERM_NAME_MAX = 100;

export class TermRuleError extends Error {
  constructor(readonly code: "key-format" | "key-taken" | "name-required" | "name-too-long") {
    super(code);
    this.name = "TermRuleError";
  }
}

/** A create found the key already in use (exact, or differing only in letters' case). Its message is shown to staff as written. */
export class TermExistsError extends Error {
  constructor(readonly existing: TermRecord) {
    super(`A ${existing.kind} with the key ${existing.key} already exists: ${existing.displayName ?? existing.key}.`);
    this.name = "TermExistsError";
  }
}

function checkTermName(input: TermInput): string {
  const name = input.displayName?.trim() ?? "";
  if (name === "") throw new TermRuleError("name-required");
  if (name.length > TERM_NAME_MAX) throw new TermRuleError("name-too-long");
  return name;
}

/** Staff-edit rules for PUT /terms. Not applied by upsertTerm, so the legacy importer keeps its legacy keys and null names. */
export async function checkTermWrite(db: Db, input: TermInput): Promise<void> {
  checkTermName(input);
  const [exact] = await db
    .select({ key: terms.key })
    .from(terms)
    .where(and(eq(terms.kind, input.kind), eq(terms.key, input.key)));
  if (exact) return;
  if (!NEW_TERM_KEY.test(input.key)) throw new TermRuleError("key-format");
  const [variant] = await db
    .select({ key: terms.key })
    .from(terms)
    .where(and(eq(terms.kind, input.kind), sql`lower(${terms.key}) = lower(${input.key})`));
  if (variant) throw new TermRuleError("key-taken");
}

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
  opts: {
    legacyId?: string;
    /** Raw legacy HTML (sectors only). undefined keeps the stored value; a difference alone is stored with no event. */
    legacyExtras?: LegacyExtras | null;
    /** Who is making the change, for Core's audit trail. The importer leaves it out. */
    audit?: AuditActor;
  } = {},
): Promise<{ record: TermRecord; changed: boolean }> {
  const data = termInputSchema.parse(input);
  return db.transaction(async (tx) => {
    await lockAggregate(tx, termAggregateId(data.kind, data.key));
    const [existing] = await tx
      .select()
      .from(terms)
      .where(and(eq(terms.kind, data.kind), eq(terms.key, data.key)))
      .for("update");
    if (existing) {
      const { updatedAt: _u, ...current } = toTermRecord(existing);
      if (JSON.stringify(termInputSchema.parse(current)) === JSON.stringify(data)) {
        const legacyIdDiffers = opts.legacyId !== undefined && opts.legacyId !== existing.legacyId;
        const extrasDiffer = opts.legacyExtras !== undefined && !sameLegacyExtras(existing.legacyExtras, opts.legacyExtras);
        if (legacyIdDiffers || extrasDiffer) {
          const [row] = await tx
            .update(terms)
            .set({
              ...(legacyIdDiffers ? { legacyId: opts.legacyId } : {}),
              ...(extrasDiffer ? { legacyExtras: opts.legacyExtras ?? null } : {}),
            })
            .where(and(eq(terms.kind, data.kind), eq(terms.key, data.key)))
            .returning();
          return { record: toTermRecord(row!), changed: false };
        }
        return { record: toTermRecord(existing), changed: false };
      }
    }
    const values = {
      ...data,
      legacyId: opts.legacyId ?? existing?.legacyId ?? null,
      ...(opts.legacyExtras !== undefined ? { legacyExtras: opts.legacyExtras } : {}),
      updatedAt: new Date(),
    };
    const [row] = await tx
      .insert(terms)
      .values(values)
      .onConflictDoUpdate({ target: [terms.kind, terms.key], set: values })
      .returning();
    const record = toTermRecord(row!);
    await enqueueEvent(
      tx,
      { type: termEventType(record.kind, "upserted"), source: CORE_SOURCE, aggregateId: termAggregateId(record.kind, record.key), data: record },
      subscribers,
    );
    if (!existing) await recordAudit(tx, opts.audit, termEntry(record.kind, record.key, record.displayName, "term.created"));
    else {
      const before = toTermRecord(existing);
      const fields = (["sortOrder", "isActive", "social"] as const).filter((f) => JSON.stringify(before[f]) !== JSON.stringify(record[f]));
      const renamed = before.displayName !== record.displayName ? { name: { from: before.displayName, to: record.displayName } } : {};
      await recordAudit(tx, opts.audit, termEntry(record.kind, record.key, record.displayName, "term.edited", { ...renamed, fields }));
    }
    return { record, changed: true };
  });
}

/**
 * Staff "Add": creates a term and never changes an existing one. Refuses a key already in use (or
 * differing only in case) with TermExistsError. The insert is ON CONFLICT DO NOTHING under the
 * aggregate lock, so two adds of one key cannot overwrite each other. Emits the same upserted event
 * upsertTerm does, so subscribers need no change.
 */
export async function createTerm(db: Db, input: TermInput, subscribers: SubscriberConfig[], audit?: AuditActor): Promise<{ record: TermRecord }> {
  const data = termInputSchema.parse(input);
  const displayName = checkTermName(data);
  if (!NEW_TERM_KEY.test(data.key)) throw new TermRuleError("key-format");
  return db.transaction(async (tx) => {
    await lockAggregate(tx, termAggregateId(data.kind, data.key));
    const [variant] = await tx
      .select()
      .from(terms)
      .where(and(eq(terms.kind, data.kind), sql`lower(${terms.key}) = lower(${data.key})`));
    if (variant) throw new TermExistsError(toTermRecord(variant));
    const [row] = await tx
      .insert(terms)
      .values({ ...data, displayName, legacyId: null, updatedAt: new Date() })
      .onConflictDoNothing({ target: [terms.kind, terms.key] })
      .returning();
    if (!row) {
      const [existing] = await tx.select().from(terms).where(and(eq(terms.kind, data.kind), eq(terms.key, data.key)));
      throw new TermExistsError(toTermRecord(existing!));
    }
    const record = toTermRecord(row);
    await enqueueEvent(
      tx,
      { type: termEventType(record.kind, "upserted"), source: CORE_SOURCE, aggregateId: termAggregateId(record.kind, record.key), data: record },
      subscribers,
    );
    await recordAudit(tx, audit, termEntry(record.kind, record.key, record.displayName, "term.created"));
    return { record };
  });
}

export async function deactivateTerm(db: Db, kind: TermKind, key: string, subscribers: SubscriberConfig[], audit?: AuditActor): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockAggregate(tx, termAggregateId(kind, key));
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
    await enqueueEvent(tx, { type: termEventType(kind, "deactivated"), source: CORE_SOURCE, aggregateId: termAggregateId(kind, key), data: { kind, key } }, subscribers);
    await recordAudit(tx, audit, termEntry(kind, key, existing.displayName, "term.deactivated"));
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
