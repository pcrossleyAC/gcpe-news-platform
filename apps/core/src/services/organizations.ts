import { asc, eq } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { enqueueEvent, orgRecordSchema, type OrgRecord, type SubscriberConfig } from "@gcpe/events";
import { organizations } from "../db/schema";

export const orgInputSchema = orgRecordSchema.omit({ updatedAt: true });
export type OrgInput = Omit<OrgRecord, "updatedAt">;

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
  const data = orgInputSchema.parse(input);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(organizations).where(eq(organizations.key, data.key)).for("update");
    if (existing) {
      const { updatedAt: _u, ...current } = toOrgRecord(existing);
      if (sameContent(current, data)) return { record: toOrgRecord(existing), changed: false };
    }
    const values = { ...data, legacyId: opts.legacyId ?? existing?.legacyId ?? null, updatedAt: new Date() };
    const [row] = await tx
      .insert(organizations)
      .values(values)
      .onConflictDoUpdate({ target: organizations.key, set: values })
      .returning();
    const record = toOrgRecord(row!);
    await enqueueEvent(tx, { type: "org.upserted", source: "core", aggregateId: `org:${record.key}`, data: record }, subscribers);
    return { record, changed: true };
  });
}

export async function deactivateOrganization(db: Db, key: string, subscribers: SubscriberConfig[]): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(organizations)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(organizations.key, key))
      .returning({ key: organizations.key });
    if (rows.length === 0) return false;
    await enqueueEvent(tx, { type: "org.deactivated", source: "core", aggregateId: `org:${key}`, data: { key } }, subscribers);
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
