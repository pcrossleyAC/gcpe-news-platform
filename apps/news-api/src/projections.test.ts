import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { OrgRecord, ReleaseRecord } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { createNewsTestDb } from "../test/helpers";
import { categories, categoryFeatures, home, posts, resourceLinks, slides } from "./db/schema";
import { applyOrg, applyRelease, applySiteContent, applyTerm, deactivateCategory, indexKeysFor, unpublishRelease } from "./projections";
import { listenForUpdates, type UpdateTarget } from "./updates/notify";

const org: OrgRecord = {
  key: "health", displayName: "Health", abbreviation: "HLTH", sortOrder: 5, isActive: true, parentKey: null, url: "http://gov.bc.ca/health",
  displayAdditionalName: null,
  minister: { name: "Honourable Sam Placeholder", summary: "Honourable Sam Placeholder", detailsHtml: "<p>bio</p>", email: "SP.Minister@gov.bc.ca", photoUrl: null, address: "PO BOX 9050" },
  contact: null, secondContact: null, weekendContactNumber: "", social: { twitterUsername: "", flickrUrl: null, youtubeUrl: null, audioUrl: null },
  topicLinks: [], serviceLinks: [], sectorKeys: [], updatedAt: "2026-10-02T16:46:05.527-07:00",
};

describe("projections", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE posts, categories, category_features, home, slides, resource_links");
  });

  it("builds lowercased index keys", () => {
    expect(indexKeysFor({ ministryKeys: ["Health"], sectorKeys: ["economy"], tagKeys: [], themeKeys: ["T1"] })).toEqual([
      "ministries:health",
      "sectors:economy",
      "themes:t1",
    ]);
  });

  it("upserts a release and unpublishes it", async () => {
    await tdb.db.transaction((tx) => applyRelease(tx, sampleRelease));
    await tdb.db.transaction((tx) => applyRelease(tx, { ...sampleRelease, summary: "changed" }));
    const [row] = await tdb.db.select().from(posts).where(eq(posts.key, sampleRelease.key));
    expect(row!.summary).toBe("changed");
    expect(row!.indexKeys).toContain("ministries:transportation-and-transit");
    expect(row!.timestamp.toISOString()).toBe("2026-10-01T22:10:28.037Z");
    await tdb.db.transaction((tx) => unpublishRelease(tx, sampleRelease.key.toLowerCase()));
    const [after] = await tdb.db.select().from(posts).where(eq(posts.key, sampleRelease.key));
    expect(after!.isPublished).toBe(false);
  });

  it("upserts a release across key casing without a unique violation", async () => {
    await tdb.db.transaction((tx) => applyRelease(tx, { ...sampleRelease, key: "R1" }));
    await tdb.db.transaction((tx) => applyRelease(tx, { ...sampleRelease, key: "r1", summary: "changed" }));
    const rows = await tdb.db.select().from(posts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "R1", summary: "changed" });
  });

  it("projects an org into categories with ministry details", async () => {
    await tdb.db.transaction((tx) => applyOrg(tx, org));
    const [row] = await tdb.db.select().from(categories).where(eq(categories.key, "health"));
    expect(row).toMatchObject({ kind: "ministries", name: "Health", sortOrder: 5, isActive: true });
    expect(row!.ministry!.minister.email).toBe("SP.Minister@gov.bc.ca");
  });

  it("upserts an org across key casing without a unique violation", async () => {
    await tdb.db.transaction((tx) => applyOrg(tx, org));
    await tdb.db.transaction((tx) => applyOrg(tx, { ...org, key: "HEALTH", displayName: "Health Updated" }));
    const rows = await tdb.db.select().from(categories);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "health", name: "Health Updated" });
  });

  it("upserts a term across key casing without a unique violation", async () => {
    const term = { kind: "sector" as const, key: "economy", displayName: "Economy", sortOrder: 1, isActive: true, social: org.social, updatedAt: org.updatedAt };
    await tdb.db.transaction((tx) => applyTerm(tx, term));
    await tdb.db.transaction((tx) => applyTerm(tx, { ...term, key: "ECONOMY", displayName: "Economy Updated" }));
    const rows = await tdb.db.select().from(categories);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "sectors", key: "economy", name: "Economy Updated" });
  });

  it("ignores service terms", async () => {
    await tdb.db.transaction((tx) =>
      applyTerm(tx, { kind: "service", key: "x", displayName: "X", sortOrder: 0, isActive: true, social: org.social, updatedAt: org.updatedAt }),
    );
    expect(await tdb.db.select().from(categories)).toHaveLength(0);
  });

  it("notifies on deactivation only when a row actually changes", async () => {
    await tdb.db.transaction((tx) => applyOrg(tx, org)); // key "health", isActive: true

    const got: [UpdateTarget, string[]][] = [];
    const stop = await listenForUpdates(tdb.pool, (t, k) => got.push([t, k]));

    // Missing key: no row changes, so no notification.
    await tdb.db.transaction((tx) => deactivateCategory(tx, "ministries", "does-not-exist"));
    await new Promise((r) => setTimeout(r, 150));
    expect(got).toEqual([]);

    // Active -> inactive (case-insensitive match): notifies once, with the stored casing.
    await tdb.db.transaction((tx) => deactivateCategory(tx, "ministries", "HEALTH"));
    await new Promise((r) => setTimeout(r, 150));
    expect(got).toEqual([["MinistryUpdate", ["health"]]]);

    // Already inactive: no further notification.
    got.length = 0;
    await tdb.db.transaction((tx) => deactivateCategory(tx, "ministries", "health"));
    await new Promise((r) => setTimeout(r, 150));
    expect(got).toEqual([]);

    const [row] = await tdb.db.select().from(categories).where(eq(categories.key, "health"));
    expect(row!.isActive).toBe(false);

    await stop();
  });

  it("applies each site content entity", async () => {
    await tdb.db.transaction(async (tx) => {
      await applySiteContent(tx, { entity: "home", topPostKey: "a", featurePostKey: "b", liveWebcastFlashMediaManifestUrl: null, liveWebcastM3uPlaylist: null, granville: null, timestamp: "2026-10-02T10:34:49.0859062-07:00" });
      await applySiteContent(tx, { entity: "categoryFeatures", kind: "ministries", key: "Health", topPostKey: "t", featurePostKey: "f" });
      await applySiteContent(tx, {
        entity: "slides",
        slides: [{ id: "f9adfdc2-5933-4c38-a390-a18077acb213", sortIndex: 0, headline: "Get vaccinated", summary: "s", actionLabel: "READ MORE", actionUri: "https://x", imageBase64: "iVBORw0KGgo=", imageType: "image/png", facebookPostUri: null, justify: "right", timestamp: "2026-09-09T16:31:07.5216222-07:00" }],
      });
      await applySiteContent(tx, { entity: "resourceLinks", links: [{ sortIndex: 0, text: "Factsheets", uri: "/factsheets" }], timestamp: "2026-10-02T00:00:00Z" });
    });
    expect((await tdb.db.select().from(home))[0]!.featurePostKey).toBe("b");
    expect((await tdb.db.select().from(categoryFeatures))[0]).toEqual({ kind: "ministries", key: "health", topPostKey: "t", featurePostKey: "f" });
    expect((await tdb.db.select().from(slides))[0]!.image!.toString("base64")).toBe("iVBORw0KGgo=");
    expect(await tdb.db.select().from(resourceLinks)).toHaveLength(1);
  });

  it("notifies listeners only after commit", async () => {
    const got: [UpdateTarget, string[]][] = [];
    const stop = await listenForUpdates(tdb.pool, (t, k) => got.push([t, k]));
    await expect(
      tdb.db.transaction(async (tx) => {
        await applyRelease(tx, { ...sampleRelease, key: "rolled-back" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await tdb.db.transaction((tx) => applyRelease(tx, sampleRelease));
    await new Promise((r) => setTimeout(r, 200));
    await stop();
    expect(got).toEqual([["PostUpdate", [sampleRelease.key]]]);
  });
});
