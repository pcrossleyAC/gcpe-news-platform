import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNrmsTestDb, editor, sampleCreate, seedTaxonomy } from "../../test/helpers";
import { ReleaseNotFoundError, ReleaseRuleError, ReleaseStateError, VersionConflictError } from "./errors";
import {
  addDocument, addTranslation, createRelease, deleteRelease, removeDocument, removeTranslation, reorderDocuments,
  saveAsset, saveCategories, saveDocumentLanguage, saveMeta, saveSettings,
} from "./service";
import { loadView } from "./store";

describe("release editing service", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
  });
  afterAll(async () => {
    await tdb.drop();
  });
  const db = () => tdb.db;
  const doc0 = (v: Awaited<ReturnType<typeof createRelease>>) => v.documents[0]!;
  const setStatus = (id: string, status: string, extra = sql``) => tdb.db.execute(sql`UPDATE news_releases SET status = ${status}, publish_at = coalesce(publish_at, now()) ${extra} WHERE id = ${id}`);

  it("creates a release with legacy defaults, a sanitised body and an auto summary", async () => {
    const v = await createRelease(db(), { ...sampleCreate, bodyHtml: '<p onclick="x">Clinics <b>open</b>.</p><script>bad()</script>' }, editor);
    expect(v).toMatchObject({ type: "release", key: null, reference: null, status: "draft", version: 1, leadMinistryKey: "health", publishOptions: { toWeb: true, toSubscribers: true, toMediaLists: false } });
    expect(doc0(v).languages[0]).toMatchObject({ languageId: 4105, headline: "Weekend clinics open across B.C.", bodyHtml: "<p>Clinics <strong>open</strong>.</p>", contacts: ["Media Relations\nMinistry of Health\n250-555-0100"] });
    expect(v.languages[0]).toMatchObject({ languageId: 4105, location: "Victoria", summary: "Clinics open.", summaryEdited: false });
  });

  it("stories get a unique slug key from the headline", async () => {
    const a = await createRelease(db(), { ...sampleCreate, type: "story", headline: "Métis artists honoured" }, editor);
    const b = await createRelease(db(), { ...sampleCreate, type: "story", headline: "Métis artists honoured" }, editor);
    const c = await createRelease(db(), { ...sampleCreate, type: "story", headline: "中文" }, editor);
    expect([a.key, b.key]).toEqual(["metis-artists-honoured", "metis-artists-honoured-1"]);
    expect(c.key).toMatch(/^release-[0-9a-f]{8}$/);
    expect(a.publishOptions.toSubscribers).toBe(false);
  });

  it("keys are unique across all types, case-insensitively (the News API addresses posts by key alone)", async () => {
    const s = await createRelease(db(), { ...sampleCreate, type: "story", headline: "Budget 2027" }, editor);
    const f = await createRelease(db(), { ...sampleCreate, type: "factsheet", headline: "Budget 2027" }, editor);
    expect([s.key, f.key]).toEqual(["budget-2027", "budget-2027-1"]);
    await expect(tdb.pool.query(`UPDATE news_releases SET key = 'BUDGET-2027' WHERE id = $1`, [f.id])).rejects.toMatchObject({ code: "23505", constraint: "news_releases_key_idx" });
  });

  it("rejects unknown categories and per-type violations", async () => {
    await expect(createRelease(db(), { ...sampleCreate, sectors: ["nope"] }, editor)).rejects.toEqual(new ReleaseRuleError(["Unknown sector: nope"]));
    await expect(createRelease(db(), { ...sampleCreate, type: "advisory", sectors: ["health"], mediaListKeys: ["regional"] }, editor)).rejects.toBeInstanceOf(ReleaseRuleError);
    await expect(createRelease(db(), { ...sampleCreate, type: "story", mediaListKeys: ["regional"] }, editor)).rejects.toBeInstanceOf(ReleaseRuleError);
    await expect(createRelease(db(), { ...sampleCreate, leadMinistryKey: "finance" }, editor)).rejects.toEqual(new ReleaseRuleError(["The lead ministry must be one of the selected ministries."]));
    const adv = await createRelease(db(), { ...sampleCreate, type: "advisory", sectors: [], mediaListKeys: ["regional"] }, editor);
    expect(adv.publishOptions).toEqual({ toWeb: false, toSubscribers: false, toMediaLists: true });
    expect(adv.mediaListKeys).toEqual(["regional"]);
  });

  it("checks the version and bumps it on every save", async () => {
    const v = await createRelease(db(), sampleCreate, editor);
    await expect(saveCategories(db(), v.id, { version: 99, leadMinistryKey: "health", ministries: ["health"], sectors: ["health"], themes: [], tags: [] }, editor)).rejects.toBeInstanceOf(VersionConflictError);
    const v2 = await saveCategories(db(), v.id, { version: 1, leadMinistryKey: null, ministries: ["health"], sectors: ["health", "education"], themes: ["families"], tags: ["covid-19"] }, editor);
    expect(v2).toMatchObject({ version: 2, leadMinistryKey: "health", sectors: ["education", "health"], themes: ["families"], tags: ["covid-19"] });
    await expect(saveCategories(db(), "00000000-0000-4000-8000-000000000000", { version: 1, leadMinistryKey: null, ministries: [], sectors: [], themes: [], tags: [] }, editor)).rejects.toBeInstanceOf(ReleaseNotFoundError);
  });

  it("document saves: sanitise, regenerate summary until hand-edited, layout clears the other field", async () => {
    const v = await createRelease(db(), sampleCreate, editor);
    const d = doc0(v);
    const base = { pageTitle: "News Release", layout: "formal" as const, headline: "New headline", subheadline: null, organizations: "Ministry of Health", byline: "ignored", bodyHtml: "<p>Fresh lede.</p>", pageImageId: null, contacts: ["Media Relations"] };
    const v2 = await saveDocumentLanguage(db(), v.id, d.id, 4105, { ...base, version: 1 }, editor);
    expect(v2.languages[0]!.summary).toBe("Fresh lede.");
    expect(doc0(v2).languages[0]).toMatchObject({ byline: null, organizations: "Ministry of Health" });
    const v3 = await saveMeta(db(), v.id, { version: 2, key: null, redirectUrl: null, location: "Victoria", summary: "My own summary.", socialMediaSummary: null, keywords: null }, editor);
    expect(v3.languages[0]).toMatchObject({ summary: "My own summary.", summaryEdited: true });
    const v4 = await saveDocumentLanguage(db(), v.id, d.id, 4105, { ...base, version: 3, bodyHtml: "<p>Another lede.</p>" }, editor);
    expect(v4.languages[0]!.summary).toBe("My own summary.");
  });

  it("translations, documents, ordering and layout locking", async () => {
    let v = await createRelease(db(), sampleCreate, editor);
    v = await addTranslation(db(), v.id, doc0(v).id, { version: v.version, languageId: 3084 }, editor);
    expect(doc0(v).languages.map((l) => l.languageId)).toEqual([4105, 3084]);
    expect(v.languages.map((l) => l.languageId)).toEqual([4105, 3084]);
    await expect(saveDocumentLanguage(db(), v.id, doc0(v).id, 4105, { version: v.version, pageTitle: "News Release", layout: "informal", headline: "H", subheadline: null, organizations: null, byline: "B", bodyHtml: "<p>x</p>", pageImageId: null, contacts: [] }, editor)).rejects.toBeInstanceOf(ReleaseStateError);
    v = await addDocument(db(), v.id, { version: v.version, pageTitle: "Backgrounder", layout: "formal" }, editor);
    expect(v.documents.map((d) => d.sortIndex)).toEqual([0, 1]);
    const [first, second] = v.documents;
    v = await reorderDocuments(db(), v.id, { version: v.version, documentIds: [second!.id, first!.id] }, editor);
    expect(v.documents[0]!.id).toBe(second!.id);
    v = await removeTranslation(db(), v.id, first!.id, 3084, v.version, editor);
    expect(v.languages.map((l) => l.languageId)).toEqual([4105]);
    v = await removeDocument(db(), v.id, second!.id, v.version, editor);
    expect(v.documents).toHaveLength(1);
    await expect(removeDocument(db(), v.id, v.documents[0]!.id, v.version, editor)).rejects.toBeInstanceOf(ReleaseStateError);
  });

  it("asset, settings and media-list rules", async () => {
    let v = await createRelease(db(), { ...sampleCreate, mediaListKeys: ["regional"] }, editor);
    await expect(saveAsset(db(), v.id, { version: v.version, assetUrl: "https://facebook.com/x", assetAltText: null, hasMediaAssets: false }, editor)).rejects.toEqual(new ReleaseRuleError(["Facebook is no longer supported due to privacy concerns. Use YouTube or Flickr URLs instead."]));
    v = await saveAsset(db(), v.id, { version: v.version, assetUrl: "https://youtu.be/abc", assetAltText: "Video", hasMediaAssets: true }, editor);
    expect(v.assetUrl).toBe("https://youtu.be/abc");
    v = await saveSettings(db(), v.id, { version: v.version, activityId: 4521, plannedPublishAt: "2026-11-02T17:00:00Z", toSubscribers: false, toMediaLists: true, mediaListKeys: [] }, editor);
    expect(v).toMatchObject({ activityId: 4521, publishAt: "2026-11-02T17:00:00.000Z", publishOptions: { toSubscribers: false, toMediaLists: false }, mediaListKeys: [] });
    await setStatus(v.id, "published", sql`, released_at = now(), live = true`);
    const live = (await loadView(db(), v.id))!;
    await expect(saveSettings(db(), v.id, { version: live.version, activityId: null, plannedPublishAt: null, toSubscribers: false, toMediaLists: true, mediaListKeys: ["national"] }, editor)).rejects.toBeInstanceOf(ReleaseStateError);
  });

  it("an edit to a published release becomes a correction; edits while publishing stay publishing", async () => {
    const v = await createRelease(db(), sampleCreate, editor);
    await setStatus(v.id, "published", sql`, released_at = now(), live = true`);
    const live = (await loadView(db(), v.id))!;
    const c1 = await saveCategories(db(), v.id, { version: live.version, leadMinistryKey: "health", ministries: ["health"], sectors: ["education"], themes: [], tags: [] }, editor);
    expect(c1.status).toBe("publishing");
    const c2 = await saveCategories(db(), v.id, { version: c1.version, leadMinistryKey: "health", ministries: ["health"], sectors: ["health"], themes: [], tags: [] }, editor);
    expect(c2.status).toBe("publishing");
    const log = await tdb.db.execute<{ text: string }>(sql`SELECT text FROM release_log WHERE release_id = ${v.id} ORDER BY id`);
    expect(log.rows.map((r) => r.text)).toContain("Edited after publishing — will republish");
  });

  it("delete: permanent without a reference, hidden with one, refused once scheduled", async () => {
    const a = await createRelease(db(), sampleCreate, editor);
    expect(await deleteRelease(db(), a.id, a.version, editor)).toBe("deleted");
    expect(await loadView(db(), a.id)).toBeNull();
    const b = await createRelease(db(), sampleCreate, editor);
    await tdb.db.execute(sql`UPDATE news_releases SET reference = 'NEWS-99999', status = 'approved' WHERE id = ${b.id}`);
    expect(await deleteRelease(db(), b.id, b.version, editor)).toBe("hidden");
    await expect(saveCategories(db(), b.id, { version: b.version + 1, leadMinistryKey: null, ministries: [], sectors: [], themes: [], tags: [] }, editor)).rejects.toBeInstanceOf(ReleaseNotFoundError);
    const c = await createRelease(db(), sampleCreate, editor);
    await setStatus(c.id, "scheduled");
    await expect(deleteRelease(db(), c.id, c.version, editor)).rejects.toBeInstanceOf(ReleaseStateError);
  });
});
