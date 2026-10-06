import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { MAX_EVENT_BYTES, outboxEvents } from "@gcpe/events";
import { createNrmsTestDb, createScheduledRelease, editor, sampleCreate } from "../../test/helpers";
import { releaseLog, releasePublications } from "../db/schema";
import { publishDue } from "../publisher";
import { createRelease, deleteRelease } from "../releases/service";
import { approve } from "../releases/workflow";
import { replayToNewsApi } from "./replay-to-news-api";

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
