import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNrmsTestDb, editor, sampleCreate, seedTaxonomy } from "../../test/helpers";
import { ReleaseRuleError, ReleaseStateError } from "./errors";
import { addTranslation, createRelease, deleteRelease, removeTranslation, saveCategories, saveDocumentLanguage, saveMeta, saveSettings } from "./service";
import { loadView } from "./store";

/** Rules the brief lists that its own test file doesn't pin down. */
describe("release editing service — further rules", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
  });
  afterAll(async () => {
    await tdb.drop();
  });
  const db = () => tdb.db;
  const setStatus = (id: string, status: string, extra = sql``) => tdb.db.execute(sql`UPDATE news_releases SET status = ${status}, publish_at = coalesce(publish_at, now()) ${extra} WHERE id = ${id}`);
  const docBase = { pageTitle: "Story", layout: "formal" as const, subheadline: null, organizations: "Ministry of Health", byline: null, bodyHtml: "<p>x</p>", pageImageId: null, contacts: [] };
  const settings = { activityId: null, plannedPublishAt: null, toSubscribers: false, toMediaLists: false, mediaListKeys: [] as string[] };
  const deps = { timeZone: "America/Vancouver" };

  it("story keys follow the headline and meta edits until scheduled", async () => {
    let v = await createRelease(db(), { ...sampleCreate, type: "story", headline: "Bridge opens" }, editor);
    const docId = v.documents[0]!.id;
    v = await saveDocumentLanguage(db(), v.id, docId, 4105, { ...docBase, version: v.version, headline: "Bridge opens early" }, editor);
    expect(v.key).toBe("bridge-opens-early");
    v = await saveMeta(db(), v.id, { version: v.version, key: "My Custom Key!", redirectUrl: null, location: "", summary: v.languages[0]!.summary, socialMediaSummary: null, keywords: null }, editor);
    expect(v.key).toBe("my-custom-key");
    expect(v.languages[0]!.summaryEdited).toBe(false);
    await setStatus(v.id, "scheduled");
    const s = (await loadView(db(), v.id))!;
    await expect(saveMeta(db(), v.id, { version: s.version, key: "other", redirectUrl: null, location: "", summary: s.languages[0]!.summary, socialMediaSummary: null, keywords: null }, editor)).rejects.toBeInstanceOf(ReleaseStateError);
    const after = await saveDocumentLanguage(db(), v.id, docId, 4105, { ...docBase, version: s.version, headline: "Bridge opens late" }, editor);
    expect(after.key).toBe("my-custom-key");
  });

  it("a release's key can't be set through meta", async () => {
    const v = await createRelease(db(), sampleCreate, editor);
    await expect(saveMeta(db(), v.id, { version: v.version, key: "anything", redirectUrl: null, location: "", summary: "", socialMediaSummary: null, keywords: null }, editor)).rejects.toBeInstanceOf(ReleaseStateError);
  });

  it("planned publish time only in draft/approved/failed; media lists unchanged after release are fine", async () => {
    const v = await createRelease(db(), { ...sampleCreate, mediaListKeys: ["regional"] }, editor);
    await setStatus(v.id, "published", sql`, released_at = now(), live = true`);
    const live = (await loadView(db(), v.id))!;
    await expect(saveSettings(db(), v.id, { ...settings, version: live.version, plannedPublishAt: "2030-01-01T00:00:00Z", mediaListKeys: ["regional"] }, editor, deps)).rejects.toBeInstanceOf(ReleaseStateError);
    const c = await saveSettings(db(), v.id, { ...settings, version: live.version, activityId: 7, mediaListKeys: ["regional"] }, editor, deps);
    expect(c).toMatchObject({ status: "publishing", activityId: 7, publishAt: live.publishAt, mediaListKeys: ["regional"], publishOptions: { toMediaLists: true } });
  });

  it("subscribers only where NoD is allowed; unknown media lists refused; inactive terms allowed", async () => {
    const adv = await createRelease(db(), { ...sampleCreate, type: "advisory", sectors: [], mediaListKeys: ["regional"] }, editor);
    await expect(saveSettings(db(), adv.id, { ...settings, version: adv.version, toSubscribers: true, mediaListKeys: ["regional"] }, editor, deps)).rejects.toBeInstanceOf(ReleaseRuleError);
    await expect(saveSettings(db(), adv.id, { ...settings, version: adv.version, mediaListKeys: ["nope"] }, editor, deps)).rejects.toEqual(new ReleaseRuleError(["Unknown media distribution list: nope"]));
    await expect(saveMeta(db(), adv.id, { version: adv.version, key: null, redirectUrl: null, location: "", summary: "A summary", socialMediaSummary: null, keywords: null }, editor)).rejects.toBeInstanceOf(ReleaseRuleError);
    const fr = await addTranslation(db(), adv.id, adv.documents[0]!.id, { version: adv.version, languageId: 3084 }, editor);
    expect(fr.documents[0]!.languages.map((l) => l.languageId)).toEqual([4105, 3084]);
    await tdb.db.execute(sql`UPDATE category_terms SET is_active = false WHERE kind = 'themes' AND key = 'families'`);
    const v = await createRelease(db(), sampleCreate, editor);
    const v2 = await saveCategories(db(), v.id, { version: v.version, leadMinistryKey: null, ministries: ["health", "finance"], sectors: ["health"], themes: ["families"], tags: [] }, editor);
    expect(v2).toMatchObject({ leadMinistryKey: null, ministries: ["finance", "health"], themes: ["families"] });
  });

  it("removing a document's English removes the document; deleted releases log and hide", async () => {
    let v = await createRelease(db(), sampleCreate, editor);
    await expect(removeTranslation(db(), v.id, v.documents[0]!.id, 4105, v.version, editor)).rejects.toBeInstanceOf(ReleaseStateError);
    v = await addTranslation(db(), v.id, v.documents[0]!.id, { version: v.version, languageId: 3084 }, editor);
    await tdb.db.execute(sql`UPDATE news_releases SET reference = 'NEWS-88888' WHERE id = ${v.id}`);
    expect(await deleteRelease(db(), v.id, v.version, editor)).toBe("hidden");
    expect((await loadView(db(), v.id))!.status).toBe("deleted");
    const log = await tdb.db.execute<{ text: string }>(sql`SELECT text FROM release_log WHERE release_id = ${v.id} ORDER BY id`);
    expect(log.rows.map((r) => r.text)).toEqual(["Created Release", "Added a French translation", "Deleted Release"]);
  });

  it("a failed correction (released before) can't be deleted or re-planned; a failed first publish can be deleted", async () => {
    const live = await createRelease(db(), sampleCreate, editor);
    await setStatus(live.id, "failed", sql`, released_at = now(), live = true`);
    const failedLive = (await loadView(db(), live.id))!;
    await expect(deleteRelease(db(), live.id, failedLive.version, editor)).rejects.toEqual(new ReleaseStateError("This release has been published — unpublish it first."));
    await expect(saveSettings(db(), live.id, { ...settings, version: failedLive.version, plannedPublishAt: "2030-01-01T00:00:00Z" }, editor, deps)).rejects.toBeInstanceOf(ReleaseStateError);
    const same = await saveSettings(db(), live.id, { ...settings, version: failedLive.version, plannedPublishAt: failedLive.publishAt }, editor, deps);
    expect(same.publishAt).toBe(failedLive.publishAt);
    const never = await createRelease(db(), sampleCreate, editor);
    await setStatus(never.id, "failed");
    expect(await deleteRelease(db(), never.id, never.version, editor)).toBe("deleted");
  });

  it("an unpublished release (approved, released_at kept) can be re-planned and deleted", async () => {
    const v = await createRelease(db(), sampleCreate, editor);
    await tdb.db.execute(sql`UPDATE news_releases SET status = 'approved', reference = 'NEWS-77777', released_at = now() - interval '1 day' WHERE id = ${v.id}`);
    const re = await saveSettings(db(), v.id, { ...settings, version: v.version, plannedPublishAt: "2030-01-01T00:00:00Z" }, editor, deps);
    expect(re.publishAt).toBe("2030-01-01T00:00:00.000Z");
    expect(await deleteRelease(db(), v.id, re.version, editor)).toBe("hidden");
  });
});
