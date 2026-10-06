import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb, createTestApp, envelope, sendEvent } from "../test/helpers";
import { activeListKeys, needsReferenceData, publicListItems } from "./lists";

describe("lists from Core events", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createTestApp>;
  beforeAll(async () => { tdb = await createNodTestDb(); app = createTestApp(tdb.db); });
  afterAll(async () => tdb.drop());
  beforeEach(async () => { await tdb.db.execute(sql`DELETE FROM lists WHERE category <> 'emergency'`); });

  // orgRecordSchema (packages/events/src/catalogue.ts) requires every field below — a partial
  // payload fails parseEvent's validation (400), never reaching listsHandler at all.
  const org = (key: string, displayName: string, isActive = true) =>
    envelope(
      "core",
      "org.upserted",
      {
        key,
        displayName,
        abbreviation: "X",
        sortOrder: 2,
        isActive,
        parentKey: null,
        url: null,
        displayAdditionalName: null,
        minister: { name: null, summary: null, detailsHtml: null, email: null, photoUrl: null, address: null },
        contact: null,
        secondContact: null,
        weekendContactNumber: null,
        social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null },
        topicLinks: [],
        serviceLinks: [],
        sectorKeys: [],
        updatedAt: new Date().toISOString(),
      },
      `org:${key}`,
    );

  it("creates and renames a ministry list, lowercasing the key", async () => {
    expect((await sendEvent(app, org("Health", "Ministry of Health"))).status).toBe(200);
    expect((await sendEvent(app, org("Health", "Health"))).status).toBe(200);
    expect(await publicListItems(tdb.db, "ministries")).toEqual([{ key: "health", value: "Health" }]);
  });

  it("deactivating hides the list from the public items but keeps the row", async () => {
    await sendEvent(app, org("agri", "Agriculture"));
    await sendEvent(app, envelope("core", "org.deactivated", { key: "agri" }, "org:agri"));
    expect(await publicListItems(tdb.db, "ministries")).toEqual([]);
    expect(await activeListKeys(tdb.db, ["ministries:agri"])).toEqual([]);
  });

  it("maps sector/theme/tag terms to their categories", async () => {
    // termRecordSchema requires social + updatedAt too (see the org() helper's note above).
    const term = {
      kind: "sector",
      key: "Mining",
      displayName: "Mining",
      sortOrder: 1,
      isActive: true,
      social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null },
      updatedAt: new Date().toISOString(),
    };
    await sendEvent(app, envelope("core", "sector.upserted", term, "sector:mining"));
    expect(await publicListItems(tdb.db, "sectors")).toEqual([{ key: "mining", value: "Mining" }]);
  });

  it("never exposes media lists or unknown categories publicly", async () => {
    await tdb.db.execute(sql`INSERT INTO lists (list_key, category, key, name) VALUES ('media-distribution-lists:budget', 'media-distribution-lists', 'budget', 'Budget')`);
    expect(await publicListItems(tdb.db, "media-distribution-lists")).toEqual([]);
    expect(await publicListItems(tdb.db, "nope")).toEqual([]);
    expect(await activeListKeys(tdb.db, ["media-distribution-lists:budget", "*"])).toEqual(["*"]);
  });

  it("needsReferenceData is true until a ministry list exists", async () => {
    expect(await needsReferenceData(tdb.db)).toBe(true);
    await sendEvent(app, org("health", "Health"));
    expect(await needsReferenceData(tdb.db)).toBe(false);
  });
});
