import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { mintSession } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";
import type { ReleaseStatusChanged, SubscriberConfig } from "@gcpe/events";
import { createNrmsTestDb, editor, sampleCreate, seedActivity, seedTaxonomy } from "../../test/helpers";
import { createApp } from "../app";
import { publishDue } from "../publisher";
import { createRelease, deleteRelease, saveDocumentLanguage, saveSettings } from "./service";
import { approve, cancel, schedule, unpublish } from "./workflow";

const subscribers: SubscriberConfig[] = [{ name: "calendar", url: "http://calendar.invalid/events", secret: "s".repeat(40), types: ["release.status_changed"] }];
const deps = { timeZone: "America/Vancouver", subscribers };
const settings = { plannedPublishAt: null, toSubscribers: false, toMediaLists: false, mediaListKeys: [] as string[] };

describe("release.status_changed (spec addendum §11): NRMS tells the Calendar each settled status and every link change", () => {
  let tdb: TestDatabase;
  const db = () => tdb.db;
  /** Every release.status_changed enqueued so far, oldest first, with its delivery targets. */
  const sent = async () =>
    (
      await tdb.pool.query(
        `SELECT e.aggregate_id, e.sequence, e.envelope, array(SELECT d.subscriber FROM outbox_deliveries d WHERE d.event_id = e.id) AS targets
         FROM outbox_events e WHERE e.type = 'release.status_changed' ORDER BY e.created_at, e.sequence`,
      )
    ).rows.map((r) => ({ aggregateId: r.aggregate_id as string, sequence: r.sequence as number, targets: r.targets as string[], data: (r.envelope as { data: ReleaseStatusChanged }).data }));

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
    for (const id of [4101, 4102]) await seedActivity(tdb.db, id);
  });
  afterAll(() => tdb.drop());
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE news_releases, outbox_events, outbox_deliveries, aggregate_sequences CASCADE");
  });

  it("a release never linked to an activity sends nothing", async () => {
    const v = await createRelease(db(), sampleCreate, editor, undefined, subscribers);
    await approve(db(), v.id, v.version, editor, deps);
    expect(await sent()).toEqual([]);
  });

  it("draft, approved, scheduled, published, then unpublished back to approved: one event each, in order, to the Calendar", async () => {
    const created = await createRelease(db(), { ...sampleCreate, activityId: 4101 }, editor, undefined, subscribers);
    const approved = await approve(db(), created.id, created.version, editor, deps);
    const scheduled = await schedule(db(), created.id, { version: approved.version, publishAt: "now" }, editor, deps);
    await publishDue({ db: db(), subscribers });
    const live = await unpublish(db(), created.id, scheduled.version + 1, editor);
    expect(live.status).toBe("unpublishing");
    await publishDue({ db: db(), subscribers });
    const events = await sent();
    expect(events.map((e) => e.data.status)).toEqual(["draft", "approved", "scheduled", "published", "approved"]);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(events.every((e) => e.aggregateId === `release:${created.id}` && e.targets.join() === "calendar")).toBe(true);
    expect(events[0]!.data).toEqual({
      releaseId: created.id, key: null, reference: null, type: "release", activityId: 4101, previousActivityId: null,
      status: "draft", publishAt: null, releasedAt: null, headline: sampleCreate.headline,
    });
    expect(events[1]!.data).toMatchObject({ reference: approved.reference, key: approved.key });
    expect(events[3]!.data).toMatchObject({ status: "published", releasedAt: scheduled.publishAt });
  });

  it("a correction of a live release reads as published throughout: nothing is sent for it", async () => {
    const created = await createRelease(db(), { ...sampleCreate, activityId: 4101 }, editor, undefined, subscribers);
    const approved = await approve(db(), created.id, created.version, editor, deps);
    await schedule(db(), created.id, { version: approved.version, publishAt: "now" }, editor, deps);
    await publishDue({ db: db(), subscribers });
    const before = (await sent()).length;
    const doc = approved.documents[0]!;
    const edited = await saveDocumentLanguage(db(), created.id, doc.id, 4105, {
      version: approved.version + 2, pageTitle: "News Release", layout: "formal", headline: "A corrected headline", subheadline: null,
      organizations: "Ministry of Health", byline: null, bodyHtml: "<p>Corrected.</p>", pageImageId: null, contacts: [],
    }, editor);
    expect(edited.status).toBe("publishing");
    await publishDue({ db: db(), subscribers });
    expect((await sent()).length).toBe(before);
  });

  it("moving the link sends the old activity as previousActivityId; clearing it sends no activity", async () => {
    const v = await createRelease(db(), { ...sampleCreate, activityId: 4101 }, editor, undefined, subscribers);
    const moved = await saveSettings(db(), v.id, { ...settings, version: v.version, activityId: 4102 }, editor, deps);
    await saveSettings(db(), v.id, { ...settings, version: moved.version, activityId: null }, editor, deps);
    expect((await sent()).map((e) => [e.data.activityId, e.data.previousActivityId])).toEqual([[4101, null], [4102, 4101], [null, 4102]]);
  });

  it("a planned publish time change is sent; a saved setting that changes nothing the Calendar shows isn't", async () => {
    const v = await createRelease(db(), { ...sampleCreate, activityId: 4101 }, editor, undefined, subscribers);
    const planned = await saveSettings(db(), v.id, { ...settings, version: v.version, activityId: 4101, plannedPublishAt: "2031-06-11T17:00:00Z" }, editor, deps);
    await saveSettings(db(), v.id, { ...settings, version: planned.version, activityId: 4101, plannedPublishAt: "2031-06-11T17:00:00Z", toSubscribers: true }, editor, deps);
    expect((await sent()).map((e) => e.data.publishAt)).toEqual([null, "2031-06-11T17:00:00.000Z"]);
  });

  it("cancel, a failed publish, a hidden delete and a hard delete are each sent", async () => {
    const a = await createRelease(db(), { ...sampleCreate, activityId: 4101 }, editor, undefined, subscribers);
    const aOk = await approve(db(), a.id, a.version, editor, deps);
    const aSched = await schedule(db(), a.id, { version: aOk.version, publishAt: "now" }, editor, deps);
    const aBack = await cancel(db(), a.id, aSched.version, editor, subscribers);
    // A body the publisher refuses, so the publish fails.
    const doc = aBack.documents[0]!;
    await tdb.db.execute(sql`UPDATE document_languages SET body_html = '' WHERE document_id = ${doc.id}`);
    await tdb.db.execute(sql`UPDATE news_releases SET status = 'scheduled', publish_at = now() - interval '1 minute' WHERE id = ${a.id}`);
    expect((await publishDue({ db: db(), subscribers })).failed).toHaveLength(1);
    const failed = await tdb.pool.query("SELECT version FROM news_releases WHERE id = $1", [a.id]);
    await deleteRelease(db(), a.id, failed.rows[0].version as number, editor, undefined, subscribers);
    const b = await createRelease(db(), { ...sampleCreate, activityId: 4102 }, editor, undefined, subscribers);
    expect(await deleteRelease(db(), b.id, b.version, editor, undefined, subscribers)).toBe("deleted");
    const statuses = (await sent()).map((e) => [e.data.activityId, e.data.status]);
    expect(statuses).toEqual([[4101, "draft"], [4101, "approved"], [4101, "scheduled"], [4101, "approved"], [4101, "failed"], [4101, "deleted"], [4102, "draft"], [4102, "deleted"]]);
  });

  it("the HTTP routes send it to the app's own subscribers: create, settings, approve, schedule, cancel, delete", async () => {
    const secret = "z".repeat(40);
    const app = createApp({ db: db(), auth: { session: { secret } }, eventSecrets: {}, workflow: { timeZone: "America/Vancouver" }, subscribers });
    const cookie = `gcpe_session=${(await mintSession(secret, { id: "00000000-0000-4000-8000-0000000000e1", name: "Pat Editor", email: "pat@example.test", roles: ["NRMS.Editor"] })).token}`;
    const call = async (method: "post" | "put", path: string, body: object) => {
      const res = await request(app)[method](`/api${path}`).set("cookie", cookie).set("x-gcpe-request", "1").send(body);
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      return res.body as { id: string; version: number };
    };
    const v = await call("post", "/releases", { ...sampleCreate, activityId: 4101 });
    const s = await call("put", `/releases/${v.id}/settings`, { ...settings, version: v.version, activityId: 4102 });
    const a = await call("post", `/releases/${v.id}/approve`, { version: s.version });
    const sc = await call("post", `/releases/${v.id}/schedule`, { version: a.version, publishAt: "2031-06-11T17:00:00Z" });
    const c = await call("post", `/releases/${v.id}/cancel`, { version: sc.version });
    await call("post", `/releases/${v.id}/delete`, { version: c.version });
    const events = await sent();
    expect(events.map((e) => e.data.status)).toEqual(["draft", "draft", "approved", "scheduled", "approved", "deleted"]);
    expect(events.every((e) => e.targets.join() === "calendar")).toBe(true);
  });
});
