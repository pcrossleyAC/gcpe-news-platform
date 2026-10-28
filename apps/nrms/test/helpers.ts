import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createTestDatabase, type Db, type TestDatabase } from "@gcpe/db-kit";
import type { CreateReleaseInput, ReleaseView } from "@gcpe/nrms-contract";
import { calendarActivities, categoryTerms, mediaLists, organizations } from "../src/db/schema";
import { createRelease } from "../src/releases/service";
import type { Actor } from "../src/releases/store";
import { approve, schedule } from "../src/releases/workflow";

export const nrmsMigrations = fileURLToPath(new URL("../migrations", import.meta.url));
export const createNrmsTestDb = (): Promise<TestDatabase> => createTestDatabase({ migrationsFolder: nrmsMigrations });

/**
 * BC moved to permanent UTC-7 on 2026-11-01 (tzdata 2026b). Tests that hard-code post-2026 BC
 * instants (06:59Z is 23:59 BC) only hold when both Postgres and Node carry that rule, so call this
 * first: on older tzdata it fails with a message naming the stale runtime instead of a wrong date.
 * Probe: 2026-11-02T08:30Z is 01:30 BC under 2026b and 00:30 under the old PST rule.
 */
export async function requireBcTzdata2026b(pool: TestDatabase["pool"]): Promise<void> {
  const expected = "01:30";
  const probe = "2026-11-02T08:30:00Z";
  const pg = ((await pool.query(`SELECT to_char($1::timestamptz AT TIME ZONE 'America/Vancouver', 'HH24:MI') AS t`, [probe])).rows[0] as { t: string }).t;
  const node = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(probe));
  const stale = [pg !== expected && `Postgres (got ${pg})`, node !== expected && `Node Intl, tz ${process.versions.tz ?? "unknown"} (got ${node})`].filter(Boolean);
  if (stale.length > 0) {
    throw new Error(`tzdata predates 2026b (BC permanent UTC-7): ${stale.join("; ")} for ${probe}, expected ${expected} BC. Upgrade tzdata to run this test.`);
  }
}

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


/** A live, non-confidential Calendar activity in NRMS's projection, as activity.* would leave it. Fictional values. */
export async function seedActivity(db: Db, id: number, over: Partial<typeof calendarActivities.$inferInsert> = {}): Promise<void> {
  const row = {
    id, isConfidential: false, isDeleted: false, title: `Sample activity ${id}`, details: "Sample details.",
    startAt: new Date("2031-06-11T17:00:00Z"), endAt: new Date("2031-06-11T18:00:00Z"), nrAt: null, isAllDay: false, isConfirmed: true,
    contactMinistryKey: "health", sharedMinistryKeys: [], categoryNames: ["Approved Event"], cityName: "Victoria, BC",
    themeKeys: [], tagKeys: [], sectorKeys: ["health"], translations: [],
    ...over,
  };
  await db.insert(calendarActivities).values(row).onConflictDoUpdate({ target: calendarActivities.id, set: row });
}

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
