import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { MAX_EVENT_BYTES, outboxEvents, type SubscriberConfig } from "@gcpe/events";
import { createNrmsTestDb, createScheduledRelease, editor, sampleCreate } from "../../test/helpers";
import { releaseLog, releasePublications } from "../db/schema";
import { publishDue } from "../publisher";
import { createRelease, deleteRelease } from "../releases/service";
import { loadView } from "../releases/store";
import { approve, requestEmailAgain, unpublish } from "../releases/workflow";
import { printResult, replayToNewsApi } from "./replay-to-news-api";

const TIME_ZONE = "America/Vancouver";

describe("replayToNewsApi", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("dry run counts and lists published, live releases and enqueues nothing", async () => {
    const live = await createScheduledRelease(tdb.db);
    await publishDue({ db: tdb.db, subscribers: [] });

    const draft = await createRelease(tdb.db, sampleCreate, editor);
    const approved = await approve(tdb.db, draft.id, draft.version, editor, { timeZone: TIME_ZONE });
    const hidden = await deleteRelease(tdb.db, approved.id, approved.version, editor);
    expect(hidden).toBe("hidden");

    const scheduledNotYetDue = await createScheduledRelease(tdb.db, {}, new Date(Date.now() + 60 * 60_000));

    const before = (await tdb.pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE type = 'release.updated'")).rows[0].n as number;

    const dryRun = await replayToNewsApi(tdb.db, { confirm: false, subscribers: [] });
    expect(dryRun.confirmed).toBe(false);
    expect(dryRun.keys).toEqual([live.key]);
    expect(dryRun.keys).not.toContain(scheduledNotYetDue.key);

    const after = (await tdb.pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE type = 'release.updated'")).rows[0].n as number;
    expect(after).toBe(before);
  });

  it("--confirm enqueues exactly one release.updated per published, live release, with notify:false, source nrms, and writes no log or release_publications rows", async () => {
    const logCountBefore = (await tdb.db.select().from(releaseLog)).length;
    const pubCountBefore = (await tdb.db.select().from(releasePublications)).length;

    const result = await replayToNewsApi(tdb.db, { confirm: true, subscribers: [] });
    expect(result.confirmed).toBe(true);
    expect(result.count).toBe(1);

    const rows = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.type, "release.updated"));
    expect(rows).toHaveLength(1);
    const envelope = rows[0]!.envelope as { source: string; data: { notify: boolean; key: string } };
    expect(envelope.source).toBe("nrms");
    expect(envelope.data.notify).toBe(false);

    const logCountAfter = (await tdb.db.select().from(releaseLog)).length;
    const pubCountAfter = (await tdb.db.select().from(releasePublications)).length;
    expect(logCountAfter).toBe(logCountBefore);
    expect(pubCountAfter).toBe(pubCountBefore);
  });

  it("I4: one oversized release among others is reported as a failure, but the others still replay", async () => {
    const ok1 = await createScheduledRelease(tdb.db);
    const tooBig = await createScheduledRelease(tdb.db);
    const ok2 = await createScheduledRelease(tdb.db);
    await publishDue({ db: tdb.db, subscribers: [] });

    // Bloat the already-published release's body directly (bypassing the normal edit path's own
    // size guard, releases/record.ts's assertPublishable) so replay's own fresh-built record is
    // the thing that ends up oversized -- the scenario I4 is about, not a duplicate of that guard.
    await tdb.pool.query(
      "UPDATE document_languages SET body_html = $1 WHERE document_id IN (SELECT id FROM release_documents WHERE release_id = $2)",
      [`<p>${"x".repeat(MAX_EVENT_BYTES)}</p>`, tooBig.id],
    );

    const before = (await tdb.pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE type = 'release.updated'")).rows[0].n as number;

    const result = await replayToNewsApi(tdb.db, { confirm: true, subscribers: [] });
    expect(result.confirmed).toBe(true);
    expect(result.keys).toEqual(expect.arrayContaining([ok1.key, tooBig.key, ok2.key]));

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ key: tooBig.key });
    expect(result.failures[0]!.reason).not.toContain("params:");

    const after = (await tdb.pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE type = 'release.updated'")).rows[0].n as number;
    // Every candidate but the oversized one got enqueued -- the failure didn't roll back the
    // whole batch it was part of.
    expect(after - before).toBe(result.count - 1);

    const enqueuedKeys = (
      await tdb.pool.query<{ key: string }>(
        "SELECT envelope->'data'->>'key' AS key FROM outbox_events WHERE type = 'release.updated' ORDER BY created_at",
      )
    ).rows.map((r) => r.key);
    expect(enqueuedKeys).toEqual(expect.arrayContaining([ok1.key, ok2.key]));
    expect(enqueuedKeys).not.toContain(tooBig.key);
  });
});

// Re-review N2: the replay is a republish like any other, so it carries the release's latest
// "Email the correction" request exactly as the publisher repeats it (publisher.ts takeEmailAgain,
// review I2). If a replay event overtakes the one that first carried the request, NoD (which drops
// the older one as stale) still gets it from the replay. NoD acts on each correction number once
// (pinned in apps/nod/src/release-updated.test.ts), so a request already acted on isn't sent again.
describe("replayToNewsApi and a waiting Email the correction request", () => {
  let tdb: TestDatabase;
  const subs: SubscriberConfig[] = [{ name: "nod", url: "http://nod.invalid/events", secret: "s".repeat(40), types: ["*"] }];

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const updatedFor = async (key: string) =>
    (await tdb.pool.query("SELECT id, envelope FROM outbox_events WHERE type = 'release.updated' AND aggregate_id = $1 ORDER BY created_at, sequence", [key])).rows as {
      id: string;
      envelope: { data: Record<string, unknown> };
    }[];
  const releaseRow = async (id: string) =>
    (await tdb.pool.query("SELECT corrections_emailed, last_email_again FROM news_releases WHERE id = $1", [id])).rows[0] as {
      corrections_emailed: number;
      last_email_again: { seq: number; eventIds: string[] } | null;
    };

  it("carries the request already passed on, under the same correction number, and tracks the replay event", async () => {
    const due = await createScheduledRelease(tdb.db, { mediaListKeys: ["regional"] });
    await publishDue({ db: tdb.db, subscribers: subs });
    const plain = await createScheduledRelease(tdb.db, { headline: "Never corrected" });
    await publishDue({ db: tdb.db, subscribers: subs });
    const v = (await loadView(tdb.db, due.id))!;
    await requestEmailAgain(tdb.db, due.id, { version: v.version, subscribers: true, mediaLists: true }, editor);
    await publishDue({ db: tdb.db, subscribers: subs });
    const [carrying] = await updatedFor(due.key!);
    expect(carrying!.envelope.data.emailAgain).toMatchObject({ seq: 1, subscribers: true, mediaLists: true });
    const logsBefore = (await tdb.db.select().from(releaseLog)).length;

    const result = await replayToNewsApi(tdb.db, { confirm: true, subscribers: subs });
    expect(result.failures).toEqual([]);

    const evs = await updatedFor(due.key!);
    expect(evs).toHaveLength(2);
    const replayed = evs[1]!;
    expect(replayed.envelope.data.notify).toBe(false);
    // The very request the earlier event carried: same number, so NoD acts on it at most once.
    expect(replayed.envelope.data.emailAgain).toEqual(carrying!.envelope.data.emailAgain);
    const row = await releaseRow(due.id);
    expect(row.corrections_emailed).toBe(1);
    // The replay event counts toward "did News On Demand get it" on the release.
    expect(row.last_email_again!.eventIds).toEqual([carrying!.id, replayed.id]);
    expect((await tdb.db.select().from(releaseLog)).length).toBe(logsBefore);

    // A release never corrected carries no request.
    const [plainEv] = await updatedFor(plain.key!);
    expect(plainEv!.envelope.data).not.toHaveProperty("emailAgain");
  });

  it("the release shows News On Demand got the request when only the replay event reached it", async () => {
    const due = await createScheduledRelease(tdb.db, { mediaListKeys: ["regional"], headline: "Overtaken" });
    await publishDue({ db: tdb.db, subscribers: subs });
    const v = (await loadView(tdb.db, due.id))!;
    await requestEmailAgain(tdb.db, due.id, { version: v.version, subscribers: true, mediaLists: false }, editor);
    await publishDue({ db: tdb.db, subscribers: subs });
    const [carrying] = await updatedFor(due.key!);
    // The first carrying event is given up on; the replay's own event is delivered.
    await tdb.pool.query("UPDATE outbox_deliveries SET status = 'dead' WHERE event_id = $1", [carrying!.id]);
    expect((await loadView(tdb.db, due.id))!.lastCorrection!.state).toBe("not-delivered");
    await replayToNewsApi(tdb.db, { confirm: true, subscribers: subs });
    const replayed = (await updatedFor(due.key!)).at(-1)!;
    expect(replayed.envelope.data.emailAgain).toMatchObject({ seq: 1, subscribers: true, mediaLists: false });
    await tdb.pool.query("UPDATE outbox_deliveries SET status = 'delivered' WHERE event_id = $1", [replayed.id]);
    expect((await loadView(tdb.db, due.id))!.lastCorrection!.state).toBe("delivered");
  });

  it("an unpublished release (its request dropped) is not replayed and carries nothing", async () => {
    const due = await createScheduledRelease(tdb.db, { mediaListKeys: ["regional"], headline: "Withdrawn" });
    await publishDue({ db: tdb.db, subscribers: subs });
    const v = (await loadView(tdb.db, due.id))!;
    await requestEmailAgain(tdb.db, due.id, { version: v.version, subscribers: true, mediaLists: false }, editor);
    await publishDue({ db: tdb.db, subscribers: subs });
    await unpublish(tdb.db, due.id, (await loadView(tdb.db, due.id))!.version, editor);
    await publishDue({ db: tdb.db, subscribers: subs });
    const before = (await updatedFor(due.key!)).length;
    const result = await replayToNewsApi(tdb.db, { confirm: true, subscribers: subs });
    expect(result.keys).not.toContain(due.key);
    expect((await updatedFor(due.key!)).length).toBe(before);
  });

  // Review N1/N2: a release unpublished after the candidate list is read, before its turn, is
  // skipped (no event, so the News API can't put it back) and listed apart from those replayed.
  it("a release unpublished during the run is skipped, not replayed, and reported as skipped", async () => {
    const first = await createScheduledRelease(tdb.db, { headline: "Replayed first" });
    const second = await createScheduledRelease(tdb.db, { headline: "Unpublished mid-run" });
    await publishDue({ db: tdb.db, subscribers: subs });
    const before = (await updatedFor(second.key!)).length;
    const result = await replayToNewsApi(tdb.db, {
      confirm: true,
      subscribers: subs,
      beforeRelease: async (key) => {
        if (key === second.key) await unpublish(tdb.db, second.id, (await loadView(tdb.db, second.id))!.version, editor);
      },
    });
    expect(result.keys).toContain(second.key);
    expect(result.skipped).toEqual([second.key]);
    expect((await updatedFor(second.key!)).length).toBe(before);
    expect((await updatedFor(first.key!)).length).toBe(1);
    const out: string[] = [];
    printResult(result, (l) => out.push(l));
    expect(out).toContain(`Replayed ${result.count - 1} of ${result.count} release(s) to the News API as release.updated (notify: false).`);
    expect(out).toContain("1 release(s) skipped: unpublished or changed while the replay ran (nothing sent for them):");
    expect(out).toContain(`  ${second.key}`);
  });

  // Review N5: the one case the replay can email people: a release whose last Email the
  // correction request News On Demand hasn't confirmed getting. Listed in both runs when NoD gets
  // the replay, so the operator can decide before --confirm.
  it("lists releases carrying a request News On Demand hasn't confirmed, when NoD is a target", async () => {
    const unconfirmed = await createScheduledRelease(tdb.db, { mediaListKeys: ["regional"], headline: "Not confirmed" });
    const confirmed = await createScheduledRelease(tdb.db, { mediaListKeys: ["regional"], headline: "Confirmed" });
    await publishDue({ db: tdb.db, subscribers: subs });
    for (const r of [unconfirmed, confirmed]) {
      await requestEmailAgain(tdb.db, r.id, { version: (await loadView(tdb.db, r.id))!.version, subscribers: true, mediaLists: false }, editor);
    }
    await publishDue({ db: tdb.db, subscribers: subs });
    await tdb.pool.query("UPDATE outbox_deliveries SET status = 'delivered' WHERE subscriber = 'nod'");
    const unconfirmedEv = (await updatedFor(unconfirmed.key!)).at(-1)!;
    await tdb.pool.query("UPDATE outbox_deliveries SET status = 'dead' WHERE event_id = $1", [unconfirmedEv.id]);

    const dry = await replayToNewsApi(tdb.db, { confirm: false, subscribers: subs });
    expect(dry.unconfirmedCorrections).toEqual([unconfirmed.key]);
    const out: string[] = [];
    printResult(dry, (l) => out.push(l));
    expect(out).toContain(
      "1 release(s) will carry an Email the correction request News On Demand hasn't confirmed getting; News On Demand sends that corrected copy when this replay reaches it:",
    );
    expect(out.at(-2)).toBe(`  ${unconfirmed.key}`);

    // Without NoD among the subscribers nothing can be emailed, so nothing is listed.
    const newsApiOnly: SubscriberConfig[] = [{ name: "news-api", url: "http://news-api.invalid/events", secret: "s".repeat(40), types: ["release.updated"] }];
    expect((await replayToNewsApi(tdb.db, { confirm: false, subscribers: newsApiOnly })).unconfirmedCorrections).toEqual([]);

    // The confirmed run reports the same list, judged before its own events are added.
    const run = await replayToNewsApi(tdb.db, { confirm: true, subscribers: subs });
    expect(run.unconfirmedCorrections).toEqual([unconfirmed.key]);
  });
});
