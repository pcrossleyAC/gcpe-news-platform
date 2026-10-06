import { fileURLToPath } from "node:url";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import type { ReleaseDraft } from "../src/releases";

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
