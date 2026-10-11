import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { ReleaseStatusChanged, SubscriberConfig } from "@gcpe/events";
import { createNrmsTestDb, editor, sampleCreate, seedActivity, seedTaxonomy } from "../../test/helpers";
import { createRelease } from "../releases/service";
import { replayActivityLinks } from "./replay-activity-links";

const subscribers: SubscriberConfig[] = [{ name: "calendar", url: "http://calendar.invalid/events", secret: "s".repeat(40), types: ["release.status_changed"] }];

describe("npm run nrms:replay-activity-links (spec addendum §11 backfill)", () => {
  let tdb: TestDatabase;
  const sent = async () =>
    (await tdb.pool.query("SELECT envelope FROM outbox_events WHERE type = 'release.status_changed' ORDER BY aggregate_id")).rows.map((r) => (r.envelope as { data: ReleaseStatusChanged }).data);

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
    await seedActivity(tdb.db, 4101);
    await createRelease(tdb.db, { ...sampleCreate, headline: "Linked", activityId: 4101 }, editor);
    await createRelease(tdb.db, { ...sampleCreate, headline: "Not linked" }, editor);
    // As the Phase 3 importer leaves them: one linked to an activity that wasn't migrated, one hidden.
    const legacy = await createRelease(tdb.db, { ...sampleCreate, headline: "Legacy link" }, editor);
    await tdb.db.execute(sql`UPDATE news_releases SET activity_id = 777000 WHERE id = ${legacy.id}`);
    const hidden = await createRelease(tdb.db, { ...sampleCreate, headline: "Hidden", activityId: 4101 }, editor);
    await tdb.db.execute(sql`UPDATE news_releases SET status = 'deleted' WHERE id = ${hidden.id}`);
    // Only what the replay itself sends is under test.
    await tdb.pool.query("TRUNCATE outbox_events, outbox_deliveries CASCADE");
  });
  afterAll(() => tdb.drop());

  it("a dry run counts the linked releases, and those whose activity NRMS doesn't hold, and sends nothing", async () => {
    expect(await replayActivityLinks(tdb.db, { confirm: false, subscribers })).toEqual({ confirmed: false, count: 2, notInProjection: 1, failures: [] });
    expect(await sent()).toEqual([]);
  });

  it("confirmed, sends each linked, non-deleted release's current status to the Calendar", async () => {
    expect(await replayActivityLinks(tdb.db, { confirm: true, subscribers })).toEqual({ confirmed: true, count: 2, notInProjection: 1, failures: [] });
    expect((await sent()).map((d) => [d.headline, d.activityId, d.status, d.previousActivityId]).sort()).toEqual([["Legacy link", 777000, "draft", null], ["Linked", 4101, "draft", null]]);
  });
});
