// Deploy runbook order (docs/deploy/siteground.md, "NRMS link and Forecast"; spec addendum §11
// backfill): `npm run nrms:replay-activity-links -- --confirm` runs after `calendar:replay-to-nrms`,
// and may itself be run more than once (a retried deploy step, or a second import pass). A second
// confirmed run must leave exactly one link (never a duplicate) and must actually resend the
// release's *current* status -- not silently do nothing. Calls the same function the npm script
// runs, against the running stack's own database, then drives delivery with the normal tick --
// exactly as a real run would.
//
// `release_links` is keyed by `release_id`, so "exactly one link" holds structurally whatever
// the replay does -- it doesn't prove the second run was applied. Two things pin that down: the
// release's status is changed behind NRMS's back (direct SQL, bypassing the normal workflow)
// between the two runs, so the Calendar can only show the new status if the second run actually
// resent it; and `release_links.last_sequence` must strictly rise on each confirmed run (it's the
// envelope's own per-aggregate sequence, stamped by the Calendar's projection handler) -- a repeat
// run that silently skipped everything, or a projection that ignored the resend, would leave it
// unchanged and fail this test.
import { test, expect } from "@playwright/test";
import { eq, sql } from "drizzle-orm";
import type { SubscriberConfig } from "@gcpe/events";
import type { ReleaseView } from "@gcpe/nrms-contract";
import { replayActivityLinks } from "../../apps/nrms/src/cli/replay-activity-links";
import { releaseLinks } from "../../apps/calendar/src/db/schema";
import { CAL_HQ_ADMIN_EMAIL, EDITOR_EMAIL } from "./constants";
import { activityInput, listFixture, sessionOf } from "./calendar-support";
import { apiCall, calendarDb, createPublishableRelease, nrmsDb, tick } from "./playwright-support";

const subscribers: SubscriberConfig[] = [{ name: "calendar", url: "http://calendar.invalid/events", secret: "s".repeat(40), types: ["release.status_changed"] }];

test.describe("npm run nrms:replay-activity-links -- --confirm, run twice (deploy order: after calendar:replay-to-nrms)", () => {
  test("a second confirmed run leaves exactly one link, no duplicate, and actually resends the release's current state", async () => {
    const f = await listFixture();
    const hq = await sessionOf(CAL_HQ_ADMIN_EMAIL);
    const editor = await sessionOf(EDITOR_EMAIL);
    const stamp = Date.now();
    const activity = await apiCall<{ id: number }>(hq, "/calendar/api/activities", {
      method: "POST",
      body: activityInput({ category: f.category, city: f.city }, { title: `Replay repeat ${stamp}`, ministry: "health", contact: f.health, time: "09:00", date: "2031-07-09" }),
    });

    // Link a release only once the activity has reached NRMS's own projection (C142: an unknown id is refused).
    let release: ReleaseView | undefined;
    await expect
      .poll(
        async () => {
          await tick();
          try {
            release = await createPublishableRelease(editor, { activityId: activity.id });
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    const linksFor = () => calendarDb().select().from(releaseLinks).where(eq(releaseLinks.releaseId, release!.id));
    const statusesOn = async () =>
      (await apiCall<{ releases: { releaseId: string; status: string }[] }>(hq, `/calendar/api/activities/${activity.id}`)).releases.map((r) => ({ releaseId: r.releaseId, status: r.status }));
    const lastSequenceFor = async () => (await linksFor())[0]!.lastSequence;

    const first = await replayActivityLinks(nrmsDb(), { confirm: true, subscribers });
    expect(first.confirmed).toBe(true);
    expect(first.failures).toEqual([]);
    await tick();
    expect(await linksFor()).toHaveLength(1);
    expect(await statusesOn()).toEqual([{ releaseId: release!.id, status: "draft" }]);
    const sequenceAfterFirst = await lastSequenceFor();

    // Change the release behind NRMS's own workflow (direct SQL, as a real import running
    // concurrently with a retried deploy step might leave it) -- a second replay that actually
    // resends the current state must carry this forward; one that's a no-op would leave the
    // Calendar showing the stale "draft" status.
    await nrmsDb().execute(sql`UPDATE news_releases SET status = 'approved' WHERE id = ${release!.id}`);

    const second = await replayActivityLinks(nrmsDb(), { confirm: true, subscribers });
    expect(second.confirmed).toBe(true);
    expect(second.failures).toEqual([]);
    await tick();
    expect(await linksFor()).toHaveLength(1);
    expect(await statusesOn()).toEqual([{ releaseId: release!.id, status: "approved" }]);
    expect(await lastSequenceFor()).toBeGreaterThan(sequenceAfterFirst);
  });
});
