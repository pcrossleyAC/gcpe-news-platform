import { describe, expect, it } from "vitest";
import { categoriesSchema, createReleaseSchema, documentLanguageSchema, listQuerySchema, metaSchema, scheduleSchema, settingsSchema } from "./schemas";

describe("schemas", () => {
  it("create: only creatable types, required headline and page title", () => {
    const ok = createReleaseSchema.parse({ type: "release", pageTitle: "News Release", layout: "formal", headline: "Clinics open", ministries: ["health"], sectors: ["health"] });
    expect(ok).toMatchObject({ themes: [], tags: [], mediaListKeys: [], organizations: null, byline: null, bodyHtml: "", location: "", contacts: [], activityId: null });
    expect(createReleaseSchema.safeParse({ ...ok, type: "update" }).success).toBe(false);
    expect(createReleaseSchema.safeParse({ ...ok, headline: "" }).success).toBe(false);
    expect(createReleaseSchema.safeParse({ ...ok, pageTitle: "x".repeat(51) }).success).toBe(false);
  });
  it("field length limits follow the legacy schema", () => {
    const base = { version: 1, pageTitle: "T", layout: "formal", headline: "H", subheadline: null, organizations: null, byline: null, bodyHtml: "", pageImageId: null, contacts: [] };
    expect(documentLanguageSchema.safeParse(base).success).toBe(true);
    expect(documentLanguageSchema.safeParse({ ...base, headline: "x".repeat(256) }).success).toBe(false);
    expect(documentLanguageSchema.safeParse({ ...base, subheadline: "x".repeat(101) }).success).toBe(false);
    expect(documentLanguageSchema.safeParse({ ...base, contacts: ["x".repeat(251)] }).success).toBe(false);
    expect(metaSchema.safeParse({ version: 1, key: null, redirectUrl: "ftp://x", location: "", summary: "", socialMediaSummary: null, keywords: null }).success).toBe(false);
    expect(metaSchema.safeParse({ version: 1, key: null, redirectUrl: null, location: "x".repeat(51), summary: "", socialMediaSummary: null, keywords: null }).success).toBe(false);
  });
  it("activity id is numeric, categories are lowercased and de-duplicated", () => {
    expect(settingsSchema.safeParse({ version: 1, activityId: "12a", toSubscribers: true, toMediaLists: false, mediaListKeys: [] }).success).toBe(false);
    expect(categoriesSchema.parse({ version: 1, leadMinistryKey: "Health", ministries: ["Health", "health"], sectors: [], themes: [], tags: [] })).toMatchObject({ leadMinistryKey: "health", ministries: ["health"] });
  });
  it("schedule takes 'now' or an offset datetime; list query has defaults", () => {
    expect(scheduleSchema.parse({ version: 3, publishAt: "now" }).publishAt).toBe("now");
    expect(scheduleSchema.safeParse({ version: 3, publishAt: "2026-10-04T09:00:00" }).success).toBe(false);
    expect(listQuerySchema.parse({ folder: "drafts" })).toEqual({ folder: "drafts", type: "all", page: 1, pageSize: 25 });
  });
});
