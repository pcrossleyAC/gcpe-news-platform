// Acceptance item 6: "Scheduled publish goes out at its minute; a late run still publishes and
// still makes the Flickr photo public."
//
// Real-time note (task-6-brief.md): the SchedulePicker's date/time inputs (and the server's
// `publishAtLocal`) only have minute granularity, so the finest schedule this suite can ask for
// is "the next BC-local minute boundary" — up to 60 real seconds away. This spec waits for real
// wall-clock time to reach that boundary (never more than ~65s), which is under the brief's
// ~90s-per-spec ceiling; ticking strictly *after* that moment (never exactly at :00) is itself
// "a late run".
import { test, expect } from "@playwright/test";
import { EDITOR_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { apiCall, approveRelease, bcLocalParts, createPublishableRelease, loginForCookie, nextMinuteBoundaryMs, tick } from "./playwright-support";
import type { AssetStatus, ReleaseView } from "@gcpe/nrms-contract";

test.describe("item 6: scheduled publish fires at its minute, even late, and makes the Flickr photo public", () => {
  test("a release scheduled for the next minute stays scheduled until then, publishes once due, and its Flickr photo goes public", async () => {
    test.setTimeout(120_000);
    const cookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);

    const created = await createPublishableRelease(cookie);
    // Attach a (fake, private-by-default) Flickr asset before approving.
    const withAsset = await apiCall<ReleaseView>(cookie, `/nrms/api/releases/${created.id}/asset`, {
      method: "PUT",
      // The fake Flickr (packages/flickr-fake/src/index.ts's defaultPhotos) only recognises a
      // fixed id set — this one is reserved for this spec; flickr-outage.spec.ts (item 9) uses
      // a different one from the same set, since both specs share one fake-Flickr instance.
      body: { version: created.version, assetUrl: "https://www.flickr.com/photos/bcgovphotos/53000000001/", assetAltText: "Photo", hasMediaAssets: true },
    });
    const approved = await approveRelease(cookie, withAsset);

    const dueAtMs = nextMinuteBoundaryMs(new Date());
    const { date, time } = bcLocalParts(new Date(dueAtMs));
    const scheduled = await apiCall<ReleaseView>(cookie, `/nrms/api/releases/${approved.id}/schedule`, {
      method: "POST",
      body: { version: approved.version, publishAtLocal: `${date}T${time}` },
    });
    expect(scheduled.status).toBe("scheduled");

    // Ticking right away, before the minute arrives, must not publish it early.
    await tick();
    const stillScheduled = await apiCall<ReleaseView>(cookie, `/nrms/api/releases/${approved.id}`);
    expect(stillScheduled.status).toBe("scheduled");

    const waitMs = dueAtMs - Date.now() + 1500; // past the boundary, into "late" territory
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

    await tick();
    await tick(); // second pass for the Flickr job, same hedge used elsewhere in this suite

    const published = await apiCall<ReleaseView>(cookie, `/nrms/api/releases/${approved.id}`);
    expect(published.status).toBe("published");
    expect(published.releasedAt).not.toBeNull();

    const status = await apiCall<AssetStatus>(cookie, `/nrms/api/releases/${approved.id}/asset-status`);
    if (status.kind !== "flickr") throw new Error(`expected a flickr asset status, got ${status.kind}`);
    expect(status.state).toBe("public");
  });
});
