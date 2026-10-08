import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@gcpe/db-kit";
import { enqueueEvent, orgRecordSchema, type OrgRecord, type SubscriberConfig } from "@gcpe/events";
import { organizations } from "../db/schema";
import { CORE_SOURCE, lockAggregate, orgAggregateId } from "./aggregate";

/**
 * isHq is optional on input: omitted keeps the stored flag (false for a new organization), so
 * re-running the BC seed or the legacy importer never clears an HQ flag set by Core.Admin.
 */
export const orgInputSchema = orgRecordSchema.omit({ updatedAt: true, isHq: true }).extend({ isHq: z.boolean().optional() });
export type OrgInput = z.infer<typeof orgInputSchema>;

/** Legacy abbreviations of the HQ organizations (Q49): GCPE Headquarters, GCPE Media Relations and the Office of the Premier. Legacy matched HQ by Ministry.Abbreviation. */
export const HQ_ABBREVIATIONS = ["GCPEHQ", "GCPEMEDIA", "PREM"] as const;

export function isHqAbbreviation(abbreviation: string | null | undefined): boolean {
  return abbreviation != null && (HQ_ABBREVIATIONS as readonly string[]).includes(abbreviation.trim().toUpperCase());
}

type Row = typeof organizations.$inferSelect;

export function toOrgRecord(row: Row): OrgRecord {
  return {
    key: row.key,
    displayName: row.displayName,
    abbreviation: row.abbreviation,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    parentKey: row.parentKey,
    url: row.url,
    displayAdditionalName: row.displayAdditionalName,
    minister: row.minister,
    contact: row.contact ?? null,
    secondContact: row.secondContact ?? null,
    weekendContactNumber: row.weekendContactNumber,
    social: row.social,
    topicLinks: row.topicLinks,
    serviceLinks: row.serviceLinks,
    sectorKeys: row.sectorKeys,
    isHq: row.isHq,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function sameContent(a: OrgInput, b: OrgInput): boolean {
  return JSON.stringify(orgInputSchema.parse(a)) === JSON.stringify(orgInputSchema.parse(b));
}

export async function upsertOrganization(
  db: Db,
  input: OrgInput,
  subscribers: SubscriberConfig[],
  opts: { legacyId?: string } = {},
): Promise<{ record: OrgRecord; changed: boolean }> {
  const parsed = orgInputSchema.parse(input);
  return db.transaction(async (tx) => {
    await lockAggregate(tx, orgAggregateId(parsed.key));
    const [existing] = await tx.select().from(organizations).where(eq(organizations.key, parsed.key)).for("update");
    const data = { ...parsed, isHq: parsed.isHq ?? existing?.isHq ?? false };
    if (existing) {
      const { updatedAt: _u, ...current } = toOrgRecord(existing);
      if (sameContent(current, data)) {
        if (opts.legacyId !== undefined && opts.legacyId !== existing.legacyId) {
          const [row] = await tx
            .update(organizations)
            .set({ legacyId: opts.legacyId })
            .where(eq(organizations.key, data.key))
            .returning();
          return { record: toOrgRecord(row!), changed: false };
        }
        return { record: toOrgRecord(existing), changed: false };
      }
    }
    const values = { ...data, legacyId: opts.legacyId ?? existing?.legacyId ?? null, updatedAt: new Date() };
    const [row] = await tx
      .insert(organizations)
      .values(values)
      .onConflictDoUpdate({ target: organizations.key, set: values })
      .returning();
    const record = toOrgRecord(row!);
    await enqueueEvent(tx, { type: "org.upserted", source: CORE_SOURCE, aggregateId: orgAggregateId(record.key), data: record }, subscribers);
    return { record, changed: true };
  });
}

/** Core.Admin's HQ switch. Emits org.upserted only when the flag changes. */
export async function setOrganizationHq(db: Db, key: string, isHq: boolean, subscribers: SubscriberConfig[]): Promise<OrgRecord | null> {
  return db.transaction(async (tx) => {
    await lockAggregate(tx, orgAggregateId(key));
    const [existing] = await tx.select().from(organizations).where(eq(organizations.key, key)).for("update");
    if (!existing) return null;
    if (existing.isHq === isHq) return toOrgRecord(existing);
    const [row] = await tx.update(organizations).set({ isHq, updatedAt: new Date() }).where(eq(organizations.key, key)).returning();
    const record = toOrgRecord(row!);
    await enqueueEvent(tx, { type: "org.upserted", source: CORE_SOURCE, aggregateId: orgAggregateId(key), data: record }, subscribers);
    return record;
  });
}

export async function deactivateOrganization(db: Db, key: string, subscribers: SubscriberConfig[]): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockAggregate(tx, orgAggregateId(key));
    const [existing] = await tx.select().from(organizations).where(eq(organizations.key, key)).for("update");
    if (!existing) return false;
    if (!existing.isActive) return true;
    await tx.update(organizations).set({ isActive: false, updatedAt: new Date() }).where(eq(organizations.key, key));
    await enqueueEvent(tx, { type: "org.deactivated", source: CORE_SOURCE, aggregateId: orgAggregateId(key), data: { key } }, subscribers);
    return true;
  });
}

export async function listOrganizations(db: Db): Promise<OrgRecord[]> {
  const rows = await db.select().from(organizations).orderBy(asc(organizations.sortOrder), asc(organizations.key));
  return rows.map(toOrgRecord);
}

export async function getOrganization(db: Db, key: string): Promise<OrgRecord | null> {
  const [row] = await db.select().from(organizations).where(eq(organizations.key, key));
  return row ? toOrgRecord(row) : null;
}
