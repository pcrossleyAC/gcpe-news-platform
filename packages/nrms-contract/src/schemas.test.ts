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
    expect(settingsSchema.safeParse({ version: 1, activityId: "0", toSubscribers: true, toMediaLists: false, mediaListKeys: [] }).success).toBe(false);
    expect(settingsSchema.parse({ version: 1, activityId: "4521", toSubscribers: true, toMediaLists: false, mediaListKeys: [] }).activityId).toBe(4521);
    expect(categoriesSchema.parse({ version: 1, leadMinistryKey: "Health", ministries: ["Health", "health"], sectors: [], themes: [], tags: [] })).toMatchObject({ leadMinistryKey: "health", ministries: ["health"] });
  });
  // Fix round 1 follow-up: plannedPublishAtLocal (BC wall-clock, no offset) as an alternative
  // to plannedPublishAt — the same exactly-one-or-neither treatment scheduleSchema got, except
  // here neither is also valid (it clears the planned time).
  it("settings: plannedPublishAtLocal is an alternative to plannedPublishAt; omitting both clears it; both together is invalid", () => {
    expect(settingsSchema.parse({ version: 1, toSubscribers: false, toMediaLists: false, mediaListKeys: [] }).plannedPublishAt).toBeNull();
    expect(settingsSchema.parse({ version: 1, plannedPublishAt: null, toSubscribers: false, toMediaLists: false, mediaListKeys: [] }).plannedPublishAt).toBeNull();
    expect(settingsSchema.parse({ version: 1, plannedPublishAt: "2026-06-15T21:30:00Z", toSubscribers: false, toMediaLists: false, mediaListKeys: [] }).plannedPublishAt).toBe("2026-06-15T21:30:00Z");
    const local = settingsSchema.parse({ version: 1, plannedPublishAtLocal: "2026-12-15T14:30", toSubscribers: false, toMediaLists: false, mediaListKeys: [] });
    expect(local.plannedPublishAtLocal).toBe("2026-12-15T14:30");
    expect(local.plannedPublishAt).toBeNull(); // untouched/defaulted — the service layer reads plannedPublishAtLocal first
    expect(
      settingsSchema.safeParse({ version: 1, plannedPublishAt: "2026-06-15T21:30:00Z", plannedPublishAtLocal: "2026-12-15T14:30", toSubscribers: false, toMediaLists: false, mediaListKeys: [] })
        .success,
    ).toBe(false);
    expect(settingsSchema.safeParse({ version: 1, plannedPublishAtLocal: "not-a-datetime", toSubscribers: false, toMediaLists: false, mediaListKeys: [] }).success).toBe(false);
  });
  it("schedule takes 'now' or an offset datetime; list query has defaults", () => {
    expect(scheduleSchema.parse({ version: 3, publishAt: "now" }).publishAt).toBe("now");
    expect(scheduleSchema.safeParse({ version: 3, publishAt: "2026-10-04T09:00:00" }).success).toBe(false);
    expect(listQuerySchema.parse({ folder: "drafts" })).toEqual({ folder: "drafts", type: "all", page: 1, pageSize: 25 });
  });
  // Fix round 1 (3f Task 3), finding 3: a BC-local wall-clock alternative to publishAt, so the
  // server (not a browser with potentially stale tzdata) does the DST-aware conversion.
  it("schedule: accepts publishAtLocal (BC wall-clock, no offset) as an alternative to publishAt, but not both or neither", () => {
    expect(scheduleSchema.parse({ version: 3, publishAtLocal: "2026-12-15T14:30" }).publishAtLocal).toBe("2026-12-15T14:30");
    expect(scheduleSchema.safeParse({ version: 3 }).success).toBe(false);
    expect(scheduleSchema.safeParse({ version: 3, publishAt: "now", publishAtLocal: "2026-12-15T14:30" }).success).toBe(false);
    expect(scheduleSchema.safeParse({ version: 3, publishAtLocal: "2026-12-15T14:30:00Z" }).success).toBe(false); // must have no offset/seconds
    expect(scheduleSchema.safeParse({ version: 3, publishAtLocal: "not-a-datetime" }).success).toBe(false);
  });
  // Fix round 2, bug 1: the digit-grouping regex alone let non-existent calendar values through
  // (e.g. "2026-13-40T25:99", which Date.UTC silently normalised to 2027-02-10 01:39 instead of
  // being rejected) — publishAtLocal/plannedPublishAtLocal must reject any value whose parts
  // don't round-trip through Date.UTC unchanged.
  it("local date/times reject calendar-invalid values (month, day incl. leap years, hour, minute) with a clear message", () => {
    const invalid = [
      "2026-13-01T10:00", // no month 13
      "2026-02-29T10:00", // 2026 is not a leap year
      "2026-04-31T10:00", // April has 30 days
      "2026-06-15T24:00", // hour must be 0-23
      "2026-06-15T23:60", // minute must be 0-59
      "2026-00-15T10:00", // no month 0
      "2026-06-00T10:00", // no day 0
    ];
    for (const publishAtLocal of invalid) {
      const result = scheduleSchema.safeParse({ version: 3, publishAtLocal });
      expect(result.success, `expected ${publishAtLocal} to be rejected`).toBe(false);
      if (!result.success) expect(result.error.issues.some((i) => i.message === "Enter a real date and time.")).toBe(true);
    }
    // 2028 *is* a leap year — the one case that must be accepted.
    expect(scheduleSchema.safeParse({ version: 3, publishAtLocal: "2028-02-29T10:00" }).success).toBe(true);
    expect(settingsSchema.safeParse({ version: 1, plannedPublishAtLocal: "2026-13-40T25:99", toSubscribers: false, toMediaLists: false, mediaListKeys: [] }).success).toBe(false);
  });
});
