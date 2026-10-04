import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { dbClock, type TestDatabase } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { createFakeFlickr } from "@gcpe/flickr-fake";
import { createNrmsTestDb, createScheduledRelease, editor } from "../../test/helpers";
import { publishDue } from "../publisher";
import { saveAsset } from "../releases/service";
import { cancel, schedule, unpublish } from "../releases/workflow";
import { loadView } from "../releases/store";
import { flickrClient, type FlickrClient } from "./flickr-client";
import { flickrPrepareMedia, GIVE_UP_MS, GRACE_MS, processFlickrJobs } from "./flickr-jobs";

const subs: SubscriberConfig[] = [{ name: "news-api", url: "http://news.invalid/events", secret: "s".repeat(40), types: ["*"] }];
const creds = { apiKey: "fake-key", apiSecret: "fake-secret", accessToken: "fake-token", accessSecret: "fake-token-secret" };
const PRIVATE_IDS = ["53000000001", "53000000002", "53000000003", "53000000004", "53000000005"];
const page = (id: string) => `https://www.flickr.com/photos/bcgovphotos/${id}/`;

describe("Flickr jobs", () => {
  let tdb: TestDatabase;
  let server: Server;
  let base: string;
  let fake: ReturnType<typeof createFakeFlickr>;
  let flickr: FlickrClient;
  let t: Date;
  const now = () => t;
  const advance = (ms: number) => {
    t = new Date(t.getTime() + ms);
  };
  let alerts: { subject: string; text: string }[];
  const alert = async (subject: string, text: string) => {
    alerts.push({ subject, text });
  };

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    const app = express();
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/fake-flickr`;
    fake = createFakeFlickr({ ...creds, publicBaseUrl: base });
    app.use("/fake-flickr", fake.router);
    flickr = flickrClient({ ...creds, restUrl: `${base}/services/rest`, oembedUrl: `${base}/services/oembed` });
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE news_releases, flickr_jobs, outbox_events, outbox_deliveries, aggregate_sequences, release_log, release_publications CASCADE");
    Object.assign(fake.state, { refuseAuth: false, outageCalls: 0, deleted: [] });
    for (const id of PRIVATE_IDS) fake.photos.get(id)!.isPublic = false;
    alerts = [];
    t = await dbClock(tdb.db);
  });

  const publish = () => publishDue({ db: tdb.db, subscribers: subs, now, prepareMedia: flickrPrepareMedia({ now }) });
  const work = () => processFlickrJobs({ db: tdb.db, flickr, alert, now });
  const staticUrl = (id: string) => `${base}/static/${id}_${fake.photos.get(id)!.secret}_b.jpg`;
  const none = { published: [], updated: [], unpublished: [], failed: [], deferred: [] };
  const job = async (releaseId: string) =>
    (await tdb.pool.query("SELECT photo_id, status, attempts, first_attempt_at, last_error, static_url, alerted_at FROM flickr_jobs WHERE release_id = $1", [releaseId])).rows[0] as
      | { photo_id: string; status: string; attempts: number; first_attempt_at: Date | null; last_error: string | null; static_url: string | null; alerted_at: Date | null }
      | undefined;
  const lastEvent = async () =>
    (await tdb.pool.query("SELECT type, envelope FROM outbox_events ORDER BY created_at DESC, sequence DESC LIMIT 1")).rows[0] as { type: string; envelope: { data: Record<string, unknown> } };
  const setAsset = (id: string, url: string) => tdb.db.execute(sql`UPDATE news_releases SET asset_url = ${url} WHERE id = ${id}`);
  const scheduledWithPhoto = async (photoId: string) => {
    const r = await createScheduledRelease(tdb.db);
    await setAsset(r.id, page(photoId));
    return r;
  };

  it("1. defers until the photo is public, then publishes with its static URL", async () => {
    const r = await scheduledWithPhoto("53000000001");
    expect(await publish()).toEqual({ ...none, deferred: [r.key] });
    expect((await loadView(tdb.db, r.id))!.status).toBe("scheduled");
    expect(await job(r.id)).toMatchObject({ photo_id: "53000000001", status: "pending", attempts: 0 });

    expect(await work()).toEqual({ done: [r.key], retried: [], gaveUp: [], alerted: [], republished: [] });
    expect(fake.photos.get("53000000001")!.isPublic).toBe(true);
    expect(await job(r.id)).toMatchObject({ status: "done", static_url: staticUrl("53000000001"), last_error: null });

    expect(await publish()).toEqual({ ...none, published: [r.key] });
    const ev = await lastEvent();
    expect(ev.type).toBe("release.published");
    expect(ev.envelope.data.assetUrl).toBe(staticUrl("53000000001"));
    expect((await loadView(tdb.db, r.id))!.flickrAlert).toBeNull();
    expect(alerts).toEqual([]);
  });

  /** Refused auth: deferred, retried, then (past grace) published without the photo and alerted once. */
  const outWithoutPhoto = async () => {
    fake.state.refuseAuth = true;
    const r = await scheduledWithPhoto("53000000002");
    expect(await publish()).toEqual({ ...none, deferred: [r.key] });
    expect(await work()).toMatchObject({ done: [], retried: [r.key], gaveUp: [] });
    const j = (await job(r.id))!;
    expect(j).toMatchObject({ status: "pending", attempts: 1 });
    expect(j.last_error).toMatch(/auth/i);
    expect(j.last_error).not.toContain(creds.accessToken);
    expect(fake.photos.get("53000000002")!.isPublic).toBe(false);

    // Still within grace: deferred again, not a failure.
    advance(GRACE_MS - 1000);
    expect(await publish()).toEqual({ ...none, deferred: [r.key] });

    t = new Date(j.first_attempt_at!.getTime() + GRACE_MS + 1000);
    expect(await publish()).toEqual({ ...none, published: [r.key] });
    const ev = await lastEvent();
    expect(ev.type).toBe("release.published");
    expect(ev.envelope.data.assetUrl).toBeNull();
    const v = (await loadView(tdb.db, r.id))!;
    expect(v.status).toBe("published");
    expect(v.flickrAlert).toMatch(/^The Flickr photo couldn't be made public \(.*auth.*\)\. The release went out without it; NRMS keeps trying for 24 hours\.$/i);

    expect(await work()).toMatchObject({ alerted: [r.key] });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.subject).toBe("Flickr photo not public: Weekend clinics open across B.C.");
    expect(alerts[0]!.text).toContain("Weekend clinics open across B.C.");
    expect(alerts[0]!.text).toContain(r.key!);
    expect(alerts[0]!.text).toContain("published");
    expect(alerts[0]!.text).toContain(v.flickrAlert!);
    expect(alerts[0]!.text).toContain(page("53000000002"));
    expect(await work()).toMatchObject({ alerted: [] });
    expect(alerts).toHaveLength(1);
    return { r, firstAttemptAt: j.first_attempt_at! };
  };

  it("2. refused auth: retries, then goes out without the photo after the grace period and alerts once", async () => {
    await outWithoutPhoto();
  });

  it("3. recovery: once the photo is public the release is republished as a correction with it", async () => {
    const { r } = await outWithoutPhoto();
    fake.state.refuseAuth = false;
    advance(5 * 60_000);
    expect(await work()).toEqual({ done: [r.key], retried: [], gaveUp: [], alerted: [], republished: [r.key] });
    const moved = (await loadView(tdb.db, r.id))!;
    expect(moved.status).toBe("publishing");
    expect(moved.flickrAlert).not.toBeNull();
    const log = await tdb.pool.query("SELECT text, actor_id FROM release_log WHERE release_id = $1 ORDER BY id DESC LIMIT 1", [r.id]);
    expect(log.rows[0]).toEqual({ text: "Flickr photo is now public — republishing with the photo", actor_id: "system" });

    expect(await publish()).toEqual({ ...none, updated: [r.key] });
    const ev = await lastEvent();
    expect(ev.type).toBe("release.updated");
    expect(ev.envelope.data).toMatchObject({ assetUrl: staticUrl("53000000002"), notify: true });
    const v = (await loadView(tdb.db, r.id))!;
    expect(v).toMatchObject({ status: "published", flickrAlert: null });
    expect(await work()).toEqual({ done: [], retried: [], gaveUp: [], alerted: [], republished: [] });
    expect(alerts).toHaveLength(1);
  });

  it("4. a deleted photo gives up at once; the release goes out without it with the gave-up alert", async () => {
    fake.state.deleted = ["53000000003"];
    const r = await scheduledWithPhoto("53000000003");
    expect(await publish()).toEqual({ ...none, deferred: [r.key] });
    expect(await work()).toMatchObject({ gaveUp: [r.key], retried: [], done: [] });
    expect(await job(r.id)).toMatchObject({ status: "gave_up", last_error: "photo not found" });
    advance(GRACE_MS + 1000);
    expect(await publish()).toEqual({ ...none, published: [r.key] });
    expect((await lastEvent()).envelope.data.assetUrl).toBeNull();
    expect((await loadView(tdb.db, r.id))!.flickrAlert).toBe(
      "The Flickr photo couldn't be made public after 24 hours (photo not found). The release is live without it — re-add or replace the photo.",
    );
    expect(await work()).toMatchObject({ alerted: [r.key] });
    expect(await work()).toMatchObject({ alerted: [] });
    expect(alerts).toHaveLength(1);
  });

  it("5. after 24 hours of failures the job gives up and a second alert is sent", async () => {
    const { r, firstAttemptAt } = await outWithoutPhoto();
    t = new Date(firstAttemptAt.getTime() + GIVE_UP_MS);
    expect(await work()).toMatchObject({ gaveUp: [r.key], alerted: [r.key] });
    expect(await job(r.id)).toMatchObject({ status: "gave_up" });
    expect((await loadView(tdb.db, r.id))!.flickrAlert).toMatch(/^The Flickr photo couldn't be made public after 24 hours \(.*\)\. The release is live without it — re-add or replace the photo\.$/);
    expect(alerts).toHaveLength(2);
    expect(alerts[1]!.text).toContain("after 24 hours");
    advance(10 * 60_000);
    expect(await work()).toEqual({ done: [], retried: [], gaveUp: [], alerted: [], republished: [] });
    expect(alerts).toHaveLength(2);
  });

  it("6. a YouTube asset publishes immediately with its URL and no job", async () => {
    const r = await createScheduledRelease(tdb.db);
    await setAsset(r.id, "https://www.youtube.com/watch?v=abc123");
    expect(await publish()).toEqual({ ...none, published: [r.key] });
    expect((await lastEvent()).envelope.data.assetUrl).toBe("https://www.youtube.com/watch?v=abc123");
    expect(await job(r.id)).toBeUndefined();
  });

  it("7. changing a published release's photo defers the correction until the new photo is public", async () => {
    const r = await scheduledWithPhoto("53000000011");
    await publish();
    await work();
    expect(await publish()).toEqual({ ...none, published: [r.key] });
    const live = (await loadView(tdb.db, r.id))!;
    await saveAsset(tdb.db, r.id, { version: live.version, assetUrl: page("53000000004"), assetAltText: null, hasMediaAssets: false }, editor);
    expect((await loadView(tdb.db, r.id))!.status).toBe("publishing");

    expect(await publish()).toEqual({ ...none, deferred: [r.key] });
    expect((await loadView(tdb.db, r.id))!.status).toBe("publishing");
    expect(await job(r.id)).toMatchObject({ photo_id: "53000000004", status: "pending", attempts: 0, static_url: null });

    expect(await work()).toMatchObject({ done: [r.key] });
    expect(await publish()).toEqual({ ...none, updated: [r.key] });
    expect((await lastEvent()).envelope.data.assetUrl).toBe(staticUrl("53000000004"));
  });

  it("no Flickr configuration is a retryable failure, and an alert that fails is logged, not thrown", async () => {
    const r = await scheduledWithPhoto("53000000005");
    await publish();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing = async () => {
        throw new Error("mail down");
      };
      expect(await processFlickrJobs({ db: tdb.db, flickr: null, alert: failing, now })).toMatchObject({ retried: [r.key] });
      expect(await job(r.id)).toMatchObject({ status: "pending", last_error: "Flickr isn't configured" });
      advance(GRACE_MS + 1000);
      expect(await publish()).toMatchObject({ published: [r.key] });
      expect(await processFlickrJobs({ db: tdb.db, flickr: null, alert: failing, now })).toMatchObject({ alerted: [] });
      expect(spy).toHaveBeenCalled();
      // Not marked alerted: the next run tries again.
      expect(await processFlickrJobs({ db: tdb.db, flickr: null, alert, now })).toMatchObject({ alerted: [r.key] });
    } finally {
      spy.mockRestore();
    }
  });

  it("a job whose release no longer points at its photo is dropped without touching Flickr", async () => {
    const r = await scheduledWithPhoto("53000000001");
    await publish();
    await setAsset(r.id, "https://www.youtube.com/watch?v=abc123");
    expect(await work()).toEqual({ done: [], retried: [], gaveUp: [], alerted: [], republished: [] });
    expect(await job(r.id)).toBeUndefined();
    expect(fake.photos.get("53000000001")!.isPublic).toBe(false);
  });

  it("re-saving the asset after giving up starts a fresh job", async () => {
    fake.state.deleted = ["53000000003"];
    const r = await scheduledWithPhoto("53000000003");
    await publish();
    await work();
    expect(await job(r.id)).toMatchObject({ status: "gave_up" });
    const v = (await loadView(tdb.db, r.id))!;
    await saveAsset(tdb.db, r.id, { version: v.version, assetUrl: page("53000000003"), assetAltText: "Alt", hasMediaAssets: false }, editor);
    expect(await job(r.id)).toBeUndefined();
    fake.state.deleted = [];
    expect(await publish()).toMatchObject({ deferred: [r.key] });
    expect(await work()).toMatchObject({ done: [r.key] });
  });
  describe("only releases that are going out", () => {
    const deps = { timeZone: "America/Vancouver" };
    const version = async (id: string) => (await loadView(tdb.db, id))!.version;

    it("a deferred release that is cancelled: the photo stays private and the job is dropped", async () => {
      const r = await scheduledWithPhoto("53000000001");
      expect(await publish()).toMatchObject({ deferred: [r.key] });
      await cancel(tdb.db, r.id, await version(r.id), editor);
      expect(await work()).toEqual({ done: [], retried: [], gaveUp: [], alerted: [], republished: [] });
      expect(fake.photos.get("53000000001")!.isPublic).toBe(false);
      expect(await job(r.id)).toBeUndefined();
    });

    it("a stale job of a release no longer going out is dropped by the worker without calling Flickr", async () => {
      const r = await scheduledWithPhoto("53000000001");
      await publish();
      // Bypass cancel()'s own cleanup: the release simply isn't going out any more.
      await tdb.db.execute(sql`UPDATE news_releases SET status = 'approved' WHERE id = ${r.id}`);
      expect(await work()).toEqual({ done: [], retried: [], gaveUp: [], alerted: [], republished: [] });
      expect(fake.photos.get("53000000001")!.isPublic).toBe(false);
      expect(await job(r.id)).toBeUndefined();
    });

    it("a deferred correction that is unpublished instead: the new photo stays private, no job, no alert", async () => {
      const r = await scheduledWithPhoto("53000000011");
      await publish();
      await work();
      expect(await publish()).toMatchObject({ published: [r.key] });
      await saveAsset(tdb.db, r.id, { version: await version(r.id), assetUrl: page("53000000004"), assetAltText: null, hasMediaAssets: false }, editor);
      expect(await publish()).toMatchObject({ deferred: [r.key] });
      await unpublish(tdb.db, r.id, await version(r.id), editor);
      expect(await work()).toEqual({ done: [], retried: [], gaveUp: [], alerted: [], republished: [] });
      expect(fake.photos.get("53000000004")!.isPublic).toBe(false);
      expect(await job(r.id)).toBeUndefined();
      expect(await publish()).toMatchObject({ unpublished: [r.key] });
    });

    it("an unpublished release gets no alert email, and its alert is cleared", async () => {
      fake.state.refuseAuth = true;
      const r = await scheduledWithPhoto("53000000002");
      await publish();
      await work();
      advance(GRACE_MS + 1000);
      expect(await publish()).toMatchObject({ published: [r.key] });
      expect((await loadView(tdb.db, r.id))!.flickrAlert).not.toBeNull();
      await unpublish(tdb.db, r.id, await version(r.id), editor);
      expect(await publish()).toMatchObject({ unpublished: [r.key] });
      expect(await work()).toMatchObject({ alerted: [] });
      expect(alerts).toEqual([]);
      expect((await loadView(tdb.db, r.id))!.flickrAlert).toBeNull();
      expect(await job(r.id)).toBeUndefined();
    });

    it("a release rescheduled after an earlier failure gets a fresh grace period at its new go-live", async () => {
      fake.state.refuseAuth = true;
      const r = await scheduledWithPhoto("53000000002");
      await publish();
      await work();
      expect((await job(r.id))!.first_attempt_at).not.toBeNull();
      await cancel(tdb.db, r.id, await version(r.id), editor);
      advance(10 * 60_000);
      await schedule(tdb.db, r.id, { version: await version(r.id), publishAt: "now" }, editor, deps);
      // The old attempt is long past grace; the new go-live must wait for the photo again.
      expect(await publish()).toEqual({ ...none, deferred: [r.key] });
      expect(await job(r.id)).toMatchObject({ status: "pending", attempts: 0, first_attempt_at: null });
    });
  });

  it("two concurrent runs send one alert", async () => {
    fake.state.refuseAuth = true;
    const r = await scheduledWithPhoto("53000000002");
    await publish();
    await work();
    advance(GRACE_MS + 1000);
    expect(await publish()).toMatchObject({ published: [r.key] });
    const slow = async (subject: string, text: string) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      alerts.push({ subject, text });
    };
    const runs = await Promise.all([1, 2].map(() => processFlickrJobs({ db: tdb.db, flickr, alert: slow, now })));
    expect(runs.flatMap((x) => x.alerted)).toEqual([r.key]);
    expect(alerts).toHaveLength(1);
  });
});
