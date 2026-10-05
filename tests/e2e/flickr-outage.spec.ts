// Acceptance item 9: "Flickr failure: the release goes out on time without the photo, the
// alert shows, and the photo returns after recovery."
//
// apps/nrms/src/media/flickr-jobs.ts's real grace period is 2 real minutes, and a failed
// attempt's retry backs off by 5 more — both too long to sleep through here. This spec instead
// moves the Flickr job's own timestamps directly in the NRMS test database (support.ts's
// `nrmsDb()`) to fast-forward past them, the DB-level equivalent of the test-clock hook the
// stack itself doesn't expose, per task-6-brief.md's time-dependent-items guidance.
import { test, expect } from "@playwright/test";
import { eq, sql } from "drizzle-orm";
import { EDITOR_EMAIL, TEST_USER_PASSWORDS, ADMIN_USERNAME, ADMIN_PASSWORD } from "./constants";
import { apiCall, approveRelease, baseUrl, createPublishableRelease, loginForCookie, nrmsDb, publishNow, signInAs, tick, uniqueHeadline } from "./playwright-support";
import { flickrJobs } from "../../apps/nrms/src/db/schema";
import type { AssetStatus, ReleaseView } from "@gcpe/nrms-contract";

// The fake Flickr (packages/flickr-fake/src/index.ts's defaultPhotos) only recognises a fixed
// set of ids — "53000000001".."53000000005" (private) and "...011"/"...012" (public). Any other
// id 404s as "Photo not found" even once auth is fixed, which would masquerade as a permanent
// failure instead of exercising the auth-outage path this spec is actually about. This id is
// reserved for this spec; scheduled-publish.spec.ts (item 6) uses a different one from the same
// set, since both specs share one fake-Flickr instance for the whole suite run.
const PHOTO_ID = "53000000002";

async function setFakeFlickrRefuseAuth(adminCookie: string, refuseAuth: boolean): Promise<void> {
  const res = await fetch(`${baseUrl()}/fake-flickr/__fake/state`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-GCPE-Request": "1", cookie: adminCookie },
    body: JSON.stringify({ refuseAuth }),
  });
  if (res.status !== 200) throw new Error(`fake-flickr state change failed: ${res.status}`);
}

test.describe("item 9: Flickr outage and recovery", () => {
  test("publishes on time without the photo during an outage, then picks it up after recovery", async ({ page, context }) => {
    const editorCookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const adminCookie = await loginForCookie(ADMIN_USERNAME, ADMIN_PASSWORD);

    await setFakeFlickrRefuseAuth(adminCookie, true);
    try {
      const created = await createPublishableRelease(editorCookie, { headline: uniqueHeadline("Flickr outage release") });
      const withAsset = await apiCall<ReleaseView>(editorCookie, `/nrms/api/releases/${created.id}/asset`, {
        method: "PUT",
        body: { version: created.version, assetUrl: `https://www.flickr.com/photos/bcgovphotos/${PHOTO_ID}/`, assetAltText: "Photo", hasMediaAssets: true },
      });
      const approved = await approveRelease(editorCookie, withAsset);
      await publishNow(editorCookie, approved);

      // Tick 1: creates the Flickr job and defers the release (still within the grace period).
      await tick();
      expect((await apiCall<ReleaseView>(editorCookie, `/nrms/api/releases/${approved.id}`)).status).toBe("scheduled");

      // Fast-forward the job's first attempt to 3 minutes ago — past GRACE_MS (2 minutes).
      await nrmsDb()
        .update(flickrJobs)
        .set({ firstAttemptAt: sql`now() - interval '3 minutes'`, updatedAt: sql`now() - interval '3 minutes'` })
        .where(eq(flickrJobs.releaseId, approved.id));

      // Tick 2: the Flickr worker retries and still fails (outage); the publisher, past grace,
      // publishes anyway, without the photo, and raises the alert.
      await tick();
      const outed = await apiCall<ReleaseView>(editorCookie, `/nrms/api/releases/${approved.id}`);
      expect(outed.status).toBe("published");
      expect(outed.releasedAt).not.toBeNull();
      expect(outed.flickrAlert).not.toBeNull();

      const outedStatus = await apiCall<AssetStatus>(editorCookie, `/nrms/api/releases/${approved.id}/asset-status`);
      if (outedStatus.kind !== "flickr") throw new Error(`expected a flickr asset status, got ${outedStatus.kind}`);
      expect(outedStatus.state).not.toBe("public");

      // The alert is visible on the editor page and on the Published list row.
      await signInAs(context, "editor");
      await page.goto(`${baseUrl()}/hub/releases/${approved.id}`);
      await expect(page.getByText("Flickr alert")).toBeVisible();
      await page.goto(`${baseUrl()}/hub/releases/published`);
      await expect(page.getByText("Flickr alert").first()).toBeVisible();

      // Recovery: Flickr comes back. Clear the retry back-off (next_attempt_at) so the very
      // next tick retries immediately instead of waiting out its real 5-minute back-off.
      await setFakeFlickrRefuseAuth(adminCookie, false);
      await nrmsDb().update(flickrJobs).set({ nextAttemptAt: sql`now()` }).where(eq(flickrJobs.releaseId, approved.id));

      // Tick 3: the Flickr worker succeeds and marks the live release for republish; the
      // publisher (same tick) republishes it as a correction, now with the photo.
      await tick();
      const recovered = await apiCall<ReleaseView>(editorCookie, `/nrms/api/releases/${approved.id}`);
      expect(recovered.status).toBe("published");
      expect(recovered.flickrAlert).toBeNull();

      const recoveredStatus = await apiCall<AssetStatus>(editorCookie, `/nrms/api/releases/${approved.id}/asset-status`);
      expect(recoveredStatus).toMatchObject({ kind: "flickr", state: "public" });
    } finally {
      await setFakeFlickrRefuseAuth(adminCookie, false);
    }
  });
});
