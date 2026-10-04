import { fileURLToPath } from "node:url";
import { createTestDatabase, type Db, type TestDatabase } from "@gcpe/db-kit";
import type { CreateReleaseInput } from "@gcpe/nrms-contract";
import { categoryTerms, mediaLists, organizations } from "../src/db/schema";
import type { ReleaseDraft } from "../src/releases";
import type { Actor } from "../src/releases/store";

export const nrmsMigrations = fileURLToPath(new URL("../migrations", import.meta.url));
export const createNrmsTestDb = (): Promise<TestDatabase> => createTestDatabase({ migrationsFolder: nrmsMigrations });

export const sampleDraft: ReleaseDraft = {
  key: "2026HLTH0001-000001",
  kind: "releases",
  reference: "NEWS-00001",
  leadMinistryKey: "health",
  summary: "Clinics open on weekends.",
  socialMediaSummary: null,
  socialMediaHeadline: null,
  keywords: null,
  location: "VICTORIA",
  hasMediaAssets: false,
  hasTranslations: false,
  isNewsOnDemand: true,
  assetUrl: null,
  redirectUri: null,
  documents: [{
    pageTitle: "Weekend clinics", languageId: 4105, headline: "Weekend clinics open across B.C.", subheadline: null,
    detailsHtml: "<p>Clinics will open on weekends.</p>", byline: null,
    contacts: [{ title: "Media Relations", details: "Alex Example\n250-555-0100" }],
  }],
  ministryKeys: ["health"], sectorKeys: [], tagKeys: [], themeKeys: [],
  assets: null, translations: null,
  publishFlags: { toWeb: true, toSubscribers: true, toMediaLists: false },
  mediaListKeys: [],
};


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
