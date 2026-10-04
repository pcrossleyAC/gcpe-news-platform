import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { dbClock, type Db, type TestDatabase } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { createNrmsTestDb, createScheduledRelease, editor } from "../test/helpers";
import { ReleaseStateError } from "./releases/errors";
import { deleteRelease, saveCategories } from "./releases/service";
import { loadView } from "./releases/store";
import { cancel, schedule, unpublish } from "./releases/workflow";
import { publishDue, startPublisher } from "./publisher";

const subs: SubscriberConfig[] = [{ name: "news-api", url: "http://news.invalid/events", secret: "s".repeat(40), types: ["*"] }];
const deps = { timeZone: "America/Vancouver" };

/** Polls a condition with real timers, for tests that can't use vi.useFakeTimers (they need
 * a real setInterval racing against real async work). */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("publisher", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE news_releases, outbox_events, outbox_deliveries, aggregate_sequences, release_log, release_publications CASCADE");
  });
  const events = async () => (await tdb.pool.query("SELECT type, envelope FROM outbox_events ORDER BY created_at, sequence")).rows as { type: string; envelope: { data: Record<string, unknown> } }[];
  const logs = async (id: string) => (await tdb.pool.query("SELECT text, actor_id FROM release_log WHERE release_id = $1 ORDER BY id", [id])).rows as { text: string; actor_id: string }[];

  it("publishes due releases only, writes release.published, a frozen copy and the legacy log lines", async () => {
    const due = await createScheduledRelease(tdb.db);
    await createScheduledRelease(tdb.db, {}, new Date(Date.now() + 10 * 60_000));
    const r = await publishDue({ db: tdb.db, subscribers: subs });
    expect(r).toEqual({ published: [due.key], updated: [], unpublished: [], failed: [] });
    const v = (await loadView(tdb.db, due.id))!;
    expect(v.status).toBe("published");
    expect(v.releasedAt).toBe(due.publishAt);
    expect(v.atomId).toBe(`uuid:${due.id}`);
    const [ev] = await events();
    expect(ev!.type).toBe("release.published");
    expect(ev!.envelope.data).toMatchObject({ key: due.key, kind: "releases", publishDate: due.publishAt, isNewsOnDemand: true });
    expect((await logs(due.id)).slice(-2)).toEqual([
      { text: "Released for Publishing", actor_id: "system" },
      { text: "Published to BC Gov News and News On Demand", actor_id: "system" },
    ]);
    expect((await tdb.pool.query("SELECT count(*)::int AS n FROM release_publications WHERE release_id = $1", [due.id])).rows[0].n).toBe(1);
  });

  it("a correction re-publishes as release.updated (notify) keeping the original publish date", async () => {
    const due = await createScheduledRelease(tdb.db);
    await publishDue({ db: tdb.db, subscribers: subs });
    const live = (await loadView(tdb.db, due.id))!;
    await saveCategories(tdb.db, due.id, { version: live.version, leadMinistryKey: "health", ministries: ["health"], sectors: ["education"], themes: [], tags: [] }, editor);
    expect(await publishDue({ db: tdb.db, subscribers: subs })).toEqual({ published: [], updated: [due.key], unpublished: [], failed: [] });
    const evs = await events();
    expect(evs.map((e) => e.type)).toEqual(["release.published", "release.updated"]);
    expect(evs[1]!.envelope.data).toMatchObject({ notify: true, publishDate: due.publishAt, sectorKeys: ["education"] });
    expect((await logs(due.id)).at(-1)!.text).toBe("Republished to BC Gov News and News On Demand");
  });

  it("unpublish completes as release.unpublished and returns the release to approved", async () => {
    const due = await createScheduledRelease(tdb.db);
    await publishDue({ db: tdb.db, subscribers: subs });
    await unpublish(tdb.db, due.id, (await loadView(tdb.db, due.id))!.version, editor);
    expect(await publishDue({ db: tdb.db, subscribers: subs })).toEqual({ published: [], updated: [], unpublished: [due.key], failed: [] });
    expect((await events()).at(-1)).toMatchObject({ type: "release.unpublished", envelope: { data: { key: due.key } } });
    expect((await loadView(tdb.db, due.id))!.status).toBe("approved");
  });

  it("re-scheduling an unpublished release re-creates it with release.published, keeping the original release date", async () => {
    const due = await createScheduledRelease(tdb.db);
    await publishDue({ db: tdb.db, subscribers: subs });
    await unpublish(tdb.db, due.id, (await loadView(tdb.db, due.id))!.version, editor);
    await publishDue({ db: tdb.db, subscribers: subs });
    const back = (await loadView(tdb.db, due.id))!;
    expect(back.releasedAt).toBe(due.publishAt);
    await schedule(tdb.db, due.id, { version: back.version, publishAt: "now" }, editor, deps);
    expect(await publishDue({ db: tdb.db, subscribers: subs })).toEqual({ published: [due.key], updated: [], unpublished: [], failed: [] });
    const evs = await events();
    expect(evs.map((e) => e.type)).toEqual(["release.published", "release.unpublished", "release.published"]);
    expect(evs[2]!.envelope.data).toMatchObject({ key: due.key, publishDate: due.publishAt });
    expect(evs[2]!.envelope.data).not.toHaveProperty("notify");
    expect((await loadView(tdb.db, due.id))!).toMatchObject({ status: "published", releasedAt: due.publishAt });
    expect((await logs(due.id)).slice(-2).map((l) => l.text)).toEqual(["Released for Publishing", "Published to BC Gov News and News On Demand"]);
  });

  it("a failed correction that is re-scheduled is still a correction (release.updated, no second go-live)", async () => {
    const due = await createScheduledRelease(tdb.db);
    await publishDue({ db: tdb.db, subscribers: subs });
    const live = (await loadView(tdb.db, due.id))!;
    await saveCategories(tdb.db, due.id, { version: live.version, leadMinistryKey: "health", ministries: ["health"], sectors: ["education"], themes: [], tags: [] }, editor);
    const bodies = await tdb.pool.query("SELECT document_id, body_html FROM document_languages WHERE document_id IN (SELECT id FROM release_documents WHERE release_id = $1)", [due.id]);
    await tdb.db.execute(sql`UPDATE document_languages SET body_html = '' WHERE document_id IN (SELECT id FROM release_documents WHERE release_id = ${due.id})`);
    expect((await publishDue({ db: tdb.db, subscribers: subs })).failed).toEqual([due.key]);
    for (const b of bodies.rows) await tdb.pool.query("UPDATE document_languages SET body_html = $2 WHERE document_id = $1", [b.document_id, b.body_html]);
    await schedule(tdb.db, due.id, { version: (await loadView(tdb.db, due.id))!.version, publishAt: "now" }, editor, deps);
    expect(await publishDue({ db: tdb.db, subscribers: subs })).toEqual({ published: [], updated: [due.key], unpublished: [], failed: [] });
    expect((await events()).map((e) => e.type)).toEqual(["release.published", "release.updated"]);
  });

  /** Live release with a correction that fails (empty body); returns the restored bodies' release. */
  const failCorrection = async () => {
    const due = await createScheduledRelease(tdb.db);
    await publishDue({ db: tdb.db, subscribers: subs });
    const live = (await loadView(tdb.db, due.id))!;
    await saveCategories(tdb.db, due.id, { version: live.version, leadMinistryKey: "health", ministries: ["health"], sectors: ["education"], themes: [], tags: [] }, editor);
    await blankBodies(due.id);
    expect((await publishDue({ db: tdb.db, subscribers: subs })).failed).toEqual([due.key]);
    return due;
  };
  const blankBodies = async (id: string) => {
    const before = await tdb.pool.query("SELECT document_id, language_id, body_html FROM document_languages WHERE document_id IN (SELECT id FROM release_documents WHERE release_id = $1)", [id]);
    await tdb.db.execute(sql`UPDATE document_languages SET body_html = '' WHERE document_id IN (SELECT id FROM release_documents WHERE release_id = ${id})`);
    restore = async () => {
      for (const b of before.rows) await tdb.pool.query("UPDATE document_languages SET body_html = $3 WHERE document_id = $1 AND language_id = $2", [b.document_id, b.language_id, b.body_html]);
    };
  };
  let restore: () => Promise<void> = async () => {};
  const live = async (id: string) => (await tdb.pool.query("SELECT live FROM news_releases WHERE id = $1", [id])).rows[0].live as boolean;

  it("live follows go-live and unpublish", async () => {
    const due = await createScheduledRelease(tdb.db);
    expect(await live(due.id)).toBe(false);
    await publishDue({ db: tdb.db, subscribers: subs });
    expect(await live(due.id)).toBe(true);
    await unpublish(tdb.db, due.id, (await loadView(tdb.db, due.id))!.version, editor);
    expect(await live(due.id)).toBe(true); // still on the site until the publisher completes it
    await publishDue({ db: tdb.db, subscribers: subs });
    expect(await live(due.id)).toBe(false);
  });

  it("a failed correction is still live: it can be unpublished, but not deleted", async () => {
    const due = await failCorrection();
    const failed = (await loadView(tdb.db, due.id))!;
    expect(failed.status).toBe("failed");
    await expect(deleteRelease(tdb.db, due.id, failed.version, editor)).rejects.toEqual(new ReleaseStateError("This release has been published — unpublish it first."));
    expect((await unpublish(tdb.db, due.id, failed.version, editor)).status).toBe("unpublishing");
    expect(await publishDue({ db: tdb.db, subscribers: subs })).toEqual({ published: [], updated: [], unpublished: [due.key], failed: [] });
    expect(await live(due.id)).toBe(false);
  });

  it("a live correction that was re-scheduled can't be cancelled", async () => {
    const due = await failCorrection();
    await restore();
    const s = await schedule(tdb.db, due.id, { version: (await loadView(tdb.db, due.id))!.version, publishAt: new Date(Date.now() + 60 * 60_000).toISOString() }, editor, deps);
    expect(s.status).toBe("scheduled");
    await expect(cancel(tdb.db, due.id, s.version, editor)).rejects.toEqual(new ReleaseStateError("This release is live — save a correction or unpublish it instead."));
  });

  it("a release that was unpublished, re-scheduled and then failed isn't live, so it can be deleted", async () => {
    const due = await createScheduledRelease(tdb.db);
    await publishDue({ db: tdb.db, subscribers: subs });
    await unpublish(tdb.db, due.id, (await loadView(tdb.db, due.id))!.version, editor);
    await publishDue({ db: tdb.db, subscribers: subs });
    await schedule(tdb.db, due.id, { version: (await loadView(tdb.db, due.id))!.version, publishAt: "now" }, editor, deps);
    await blankBodies(due.id);
    expect((await publishDue({ db: tdb.db, subscribers: subs })).failed).toEqual([due.key]);
    const failed = (await loadView(tdb.db, due.id))!;
    expect(failed).toMatchObject({ status: "failed", releasedAt: due.publishAt });
    expect(await deleteRelease(tdb.db, due.id, failed.version, editor)).toBe("hidden");
  });

  it("an unpublish that keeps failing doesn't starve due releases, and failed has no duplicates", async () => {
    const stuck = await createScheduledRelease(tdb.db, {}, new Date(Date.now() - 3 * 60_000));
    await publishDue({ db: tdb.db, subscribers: subs });
    await unpublish(tdb.db, stuck.id, (await loadView(tdb.db, stuck.id))!.version, editor);
    await tdb.pool.query(`CREATE FUNCTION boom_unpublish() RETURNS trigger AS $$ BEGIN IF NEW.text = 'Unpublished from BC Gov News' THEN RAISE EXCEPTION 'simulated'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await tdb.pool.query(`CREATE TRIGGER boom_unpublish BEFORE INSERT ON release_log FOR EACH ROW EXECUTE FUNCTION boom_unpublish()`);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const due = await createScheduledRelease(tdb.db, {}, new Date(Date.now() - 60_000));
      const bad = await createScheduledRelease(tdb.db, {}, new Date(Date.now() - 2 * 60_000));
      await blankBodies(bad.id);
      const r = await publishDue({ db: tdb.db, subscribers: subs, limit: 5 });
      expect(r).toEqual({ published: [due.key], updated: [], unpublished: [], failed: [bad.key] });
      expect((await loadView(tdb.db, stuck.id))!.status).toBe("unpublishing"); // retried next run
    } finally {
      errSpy.mockRestore();
      await tdb.pool.query("DROP TRIGGER boom_unpublish ON release_log; DROP FUNCTION boom_unpublish()");
    }
  });

  it("an incomplete release fails visibly instead of sticking, and doesn't block the next one", async () => {
    const bad = await createScheduledRelease(tdb.db, {}, new Date(Date.now() - 120_000));
    await tdb.db.execute(sql`UPDATE document_languages SET body_html = '' WHERE document_id IN (SELECT id FROM release_documents WHERE release_id = ${bad.id})`);
    const good = await createScheduledRelease(tdb.db);
    const r = await publishDue({ db: tdb.db, subscribers: subs });
    expect(r).toEqual({ published: [good.key], updated: [], unpublished: [], failed: [bad.key] });
    const v = (await loadView(tdb.db, bad.id))!;
    expect(v).toMatchObject({ status: "failed", lastError: "Document 1 (English) needs body text." });
    expect((await logs(bad.id)).at(-1)!.text).toBe("Publishing failed: Document 1 (English) needs body text.");
  });

  it("skips releases on hold and honours the DB clock", async () => {
    const held = await createScheduledRelease(tdb.db);
    await tdb.db.execute(sql`UPDATE news_releases SET on_hold = true WHERE id = ${held.id}`);
    expect((await publishDue({ db: tdb.db, subscribers: subs })).published).toEqual([]);
    const later = await createScheduledRelease(tdb.db, {}, new Date(Date.now() + 60 * 60_000));
    const future = new Date((await dbClock(tdb.db)).getTime() + 2 * 60 * 60_000);
    expect((await publishDue({ db: tdb.db, subscribers: subs, now: () => future })).published).toEqual([later.key]);
  });

  it("prepareMedia can replace the asset URL in what's published", async () => {
    const due = await createScheduledRelease(tdb.db);
    await publishDue({ db: tdb.db, subscribers: subs, prepareMedia: async () => ({ assetUrl: "https://live.staticflickr.com/1/2_abc_b.jpg" }) });
    expect((await events())[0]!.envelope.data.assetUrl).toBe("https://live.staticflickr.com/1/2_abc_b.jpg");
    expect(due.key).toBeTruthy();
  });

  it("two concurrent publishDue calls partition the due releases without publishing any twice", async () => {
    const keys: string[] = [];
    for (let i = 0; i < 6; i++) keys.push((await createScheduledRelease(tdb.db)).key!);
    const [a, b] = await Promise.all([publishDue({ db: tdb.db, subscribers: subs }), publishDue({ db: tdb.db, subscribers: subs })]);
    expect([...a.failed, ...b.failed]).toEqual([]);
    expect([...a.published, ...b.published].sort()).toEqual([...keys].sort());
    expect((await tdb.pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE type = 'release.published'")).rows[0].n).toBe(6);
  });

  it("does not wait on a release locked by another transaction (FOR UPDATE SKIP LOCKED)", async () => {
    const locked = await createScheduledRelease(tdb.db);
    const free = await createScheduledRelease(tdb.db);
    const locker = await tdb.pool.connect();
    await locker.query("BEGIN");
    await locker.query("SELECT id FROM news_releases WHERE id = $1 FOR UPDATE", [locked.id]);
    try {
      const result = await Promise.race([
        publishDue({ db: tdb.db, subscribers: subs }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("publishDue waited on the locked row instead of skipping it")), 5000)),
      ]);
      expect(result).toEqual({ published: [free.key], updated: [], unpublished: [], failed: [] });
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
  }, 7000);
});

describe("startPublisher", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a publishDue error and keeps ticking; stop() awaits an in-flight run", async () => {
    let calls = 0;
    let resolveSecondRun: (() => void) | undefined;
    const fakeDb = {
      transaction: vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        await new Promise<void>((resolve) => {
          resolveSecondRun = resolve;
        });
        return null;
      }),
    } as unknown as Db;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = startPublisher({ db: fakeDb, subscribers: subs, intervalMs: 10 });

    await waitUntil(() => calls >= 1);
    await waitUntil(() => errorSpy.mock.calls.length >= 1);
    expect(errorSpy.mock.calls.some(([first]) => first === "[nrms] publish failed")).toBe(true);
    await waitUntil(() => calls >= 2);

    let stopped = false;
    const stopPromise = stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopped).toBe(false);
    resolveSecondRun?.();
    await stopPromise;
    expect(stopped).toBe(true);
  });
});
