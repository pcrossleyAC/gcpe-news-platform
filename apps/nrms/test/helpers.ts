import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createTestDatabase, type Db, type TestDatabase } from "@gcpe/db-kit";
import type { CreateReleaseInput, ReleaseView } from "@gcpe/nrms-contract";
import { categoryTerms, mediaLists, organizations } from "../src/db/schema";
import { createRelease } from "../src/releases/service";
import type { Actor } from "../src/releases/store";
import { approve, schedule } from "../src/releases/workflow";

export const nrmsMigrations = fileURLToPath(new URL("../migrations", import.meta.url));
export const createNrmsTestDb = (): Promise<TestDatabase> => createTestDatabase({ migrationsFolder: nrmsMigrations });

export const editor: Actor = { id: "00000000-0000-4000-8000-0000000000e1", name: "Test Editor" };

export async function seedTaxonomy(db: Db): Promise<void> {
  await db.insert(organizations).values([
    { key: "health", displayName: "Health", abbreviation: "HLTH", sortOrder: 1 },
    { key: "finance", displayName: "Finance", abbreviation: "FIN", sortOrder: 2 },
  ]).onConflictDoNothing();
  await db.insert(categoryTerms).values([
    { kind: "sectors", key: "health", displayName: "Health" },
    { kind: "sectors", key: "education", displayName: "Education" },
    { kind: "themes", key: "families", displayName: "Families" },
    { kind: "tags", key: "covid-19", displayName: "COVID-19" },
  ]).onConflictDoNothing();
  await db.insert(mediaLists).values([
    { key: "regional", displayName: "Regional media", sortOrder: 1 },
    { key: "national", displayName: "National media", sortOrder: 2 },
  ]).onConflictDoNothing();
}

export const sampleCreate: CreateReleaseInput = {
  type: "release", pageTitle: "News Release", layout: "formal", pageImageId: null,
  headline: "Weekend clinics open across B.C.", subheadline: null, organizations: "Ministry of Health", byline: null,
  bodyHtml: "<p>Clinics will open on weekends starting in November.</p><p>More detail.</p>", location: "Victoria",
  contacts: ["Media Relations\nMinistry of Health\n250-555-0100"],
  ministries: ["health"], leadMinistryKey: "health", sectors: ["health"], themes: [], tags: [], mediaListKeys: [], activityId: null, publishAt: null,
};


/** Created, approved and scheduled (default: due one minute ago via a direct publish_at update). */
export async function createScheduledRelease(db: Db, over: Partial<CreateReleaseInput> = {}, publishAt?: Date): Promise<ReleaseView> {
  await seedTaxonomy(db);
  const v = await createRelease(db, { ...sampleCreate, ...over }, editor);
  const a = await approve(db, v.id, v.version, editor, { timeZone: "America/Vancouver" });
  const s = await schedule(db, v.id, { version: a.version, publishAt: "now" }, editor, { timeZone: "America/Vancouver" });
  const at = publishAt ?? new Date(Date.now() - 60_000);
  await db.execute(sql`UPDATE news_releases SET publish_at = ${at.toISOString()}::timestamptz WHERE id = ${s.id}`);
  return { ...s, publishAt: at.toISOString() };
}
