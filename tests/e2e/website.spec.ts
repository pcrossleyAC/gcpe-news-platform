// Acceptance item 12: "Website: carousel goes live at its time; emergency pin persists across
// carousel changes; Live Feed and its URLs reach the home record; Blue Bridge needs Core.Admin
// plus the phrase and shows "TEST —" off production; resource links and files work."
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { ADMIN_USERNAME, ADMIN_PASSWORD, SITE_EDITOR_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { apiCall, baseUrl, bcLocalParts, loginForCookie, nextMinuteBoundaryMs, signInAs, tick, tickTwice, uniqueHeadline } from "./playwright-support";
import type { PinView } from "../../apps/staff-web/src/screens/website/types";

test.describe("item 12: Website section", () => {
  test("the scheduled carousel goes live at its time, not before", async ({ page, context }) => {
    test.setTimeout(120_000);
    await signInAs(context, "siteEditor");
    await page.goto(`${baseUrl()}/hub/website/carousel`);

    const dueAtMs = nextMinuteBoundaryMs(new Date());
    const { date, time } = bcLocalParts(new Date(dueAtMs));
    const nextSection = page.getByRole("region", { name: "Next carousel" });
    await nextSection.getByLabel("Date").fill(date);
    await nextSection.getByLabel("Time (BC time)").fill(time);
    await nextSection.getByRole("button", { name: "Create next carousel" }).click();

    const headline = uniqueHeadline("Carousel slide");
    await nextSection.getByRole("button", { name: "Add slide" }).click();
    await nextSection.getByLabel("Slide 1 headline").fill(headline);
    await nextSection.getByRole("button", { name: "Save carousel" }).click();
    await expect(nextSection.getByLabel("Slide 1 headline")).toHaveValue(headline);

    await tick();
    await expect(page.getByRole("region", { name: "Live carousel" }).getByText("No carousel is live.")).toBeVisible();

    const waitMs = dueAtMs - Date.now() + 1500;
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    await tick();

    await page.reload();
    await expect(page.getByRole("region", { name: "Live carousel" }).getByLabel("Slide 1 headline")).toHaveValue(headline);
    await expect(page.getByRole("region", { name: "Next carousel" }).getByText("There is no next carousel.")).toBeVisible();
  });

  test("an emergency pin's content and pinned state survive a carousel going live, and stays first in the public feed", async ({ page, context }) => {
    test.setTimeout(60_000);
    await signInAs(context, "siteEditor");
    await page.goto(`${baseUrl()}/hub/website/pins`);

    const primary = page.getByRole("region", { name: "Primary emergency pin" });
    const headline = uniqueHeadline("Emergency pin headline");
    await primary.getByLabel("Primary headline").fill(headline);
    // The server refuses to pin a slide with no headline — save the headline first (and wait
    // for that save to land: pinning and saving are two independent writes to the same pin row,
    // each bumping its version, so firing them back-to-back without waiting risks a stale-
    // version 409 too, same pattern as documents-bilingual.spec.ts's `clickAndWaitForSave`).
    await Promise.all([
      page.waitForResponse((r) => r.request().method() !== "GET" && r.url().includes("/nrms/api/site/pins/")),
      primary.getByRole("button", { name: "Save primary pin" }).click(),
    ]);
    await expect(primary.getByLabel("Primary headline")).toHaveValue(headline);

    await Promise.all([
      page.waitForResponse((r) => r.request().method() !== "GET" && r.url().includes("/nrms/api/site/pins/")),
      primary.getByRole("switch").click({ force: true }), // pin it on
    ]);
    await expect(primary.getByText("Primary is pinned")).toBeVisible();

    // I6: the previous version of this test only changed the carousel *through the API* and
    // never actually made anything go live, so it never exercised the one scenario the pin is
    // actually for — proving pinnedSlides()/slidesSnapshot() (apps/nrms/src/website/events.ts)
    // really does put the pin ahead of the carousel's own slides once that carousel is live, in
    // what the public News API (`/api/Slides`) serves. Self-contained: create a fresh next
    // carousel with its own slide and make it live now.
    const siteEditorCookie = await loginForCookie(SITE_EDITOR_EMAIL, TEST_USER_PASSWORDS[SITE_EDITOR_EMAIL]!);
    const data = await apiCall<{ next: { version: number } | null }>(siteEditorCookie, "/nrms/api/site/carousels");
    if (data.next) {
      await apiCall(siteEditorCookie, `/nrms/api/site/carousels/next?version=${data.next.version}`, { method: "DELETE" });
    }
    const carouselHeadline = uniqueHeadline("Carousel slide alongside the pin");
    const { date, time } = bcLocalParts(new Date());
    const next = await apiCall<{ id: string; version: number }>(siteEditorCookie, "/nrms/api/site/carousels/next", {
      method: "POST",
      body: { goLiveAtLocal: `${date}T${time}` },
    });
    await apiCall(siteEditorCookie, `/nrms/api/site/carousels/${next.id}`, {
      method: "PUT",
      body: { version: next.version, slides: [{ headline: carouselHeadline, summary: "", actionUrl: "", facebookPostUrl: "", justify: "left" }] },
    });
    await apiCall(siteEditorCookie, "/nrms/api/site/carousels/next/make-live", { method: "POST" });
    await tickTwice();

    const pins = await apiCall<PinView[]>(siteEditorCookie, "/nrms/api/site/pins");
    const primaryPin = pins.find((p) => p.slot === "primary")!;
    expect(primaryPin.pinned).toBe(true);
    expect(primaryPin.slide.headline).toBe(headline);

    // Still pinned/first in the staff UI too.
    await page.reload();
    await expect(primary.getByLabel("Primary headline")).toHaveValue(headline);
    await expect(primary.getByText("Primary is pinned")).toBeVisible();

    // And first — ahead of the now-live carousel's own slide — in the public News API feed.
    const publicSlides = (await (await fetch(`${baseUrl()}/api/Slides?api-version=1.0`)).json()) as { headline: string }[];
    expect(publicSlides.length).toBeGreaterThanOrEqual(2);
    expect(publicSlides[0]!.headline).toBe(headline);
    expect(publicSlides.some((s) => s.headline === carouselHeadline)).toBe(true);
    expect(publicSlides.findIndex((s) => s.headline === carouselHeadline)).toBeGreaterThan(publicSlides.findIndex((s) => s.headline === headline));
  });

  test("Live Feed's URLs reach the News API's home record", async () => {
    const siteEditorCookie = await loginForCookie(SITE_EDITOR_EMAIL, TEST_USER_PASSWORDS[SITE_EDITOR_EMAIL]!);
    const feed = await apiCall<{ version: number }>(siteEditorCookie, "/nrms/api/site/live-feed");
    const manifestUrl = `https://stream.example.gov.bc.ca/manifest-${Date.now()}.m3u8`;
    const m3uUrl = `https://stream.example.gov.bc.ca/playlist-${Date.now()}.m3u8`;
    await apiCall(siteEditorCookie, "/nrms/api/site/live-feed", { method: "PUT", body: { version: feed.version, enabled: true, manifestUrl, m3uUrl } });

    await tick();
    await tick();

    const home = (await (await fetch(`${baseUrl()}/api/Home?api-version=1.0`)).json()) as {
      liveWebcastFlashMediaManifestUrl: string | null;
      liveWebcastM3uPlaylist: string | null;
    };
    expect(home.liveWebcastFlashMediaManifestUrl).toBe(manifestUrl);
    expect(home.liveWebcastM3uPlaylist).toBe(m3uUrl);
  });

  test("Blue Bridge needs Core.Admin plus the confirmation phrase, and a test site's banner says TEST —", async ({ page, context }) => {
    await signInAs(context, "admin");
    await page.goto(`${baseUrl()}/hub/website/blue-bridge`);
    await expect(page.getByText("This is a TEST site.")).toBeVisible();

    const switchControl = page.getByRole("switch", { name: "Project Blue Bridge" });
    await switchControl.click({ force: true });
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Confirm button stays disabled without the exact phrase and the IGRS checkbox.
    await expect(dialog.getByRole("button", { name: /Confirm turn on/ })).toBeDisabled();
    await dialog.getByLabel(/Type KING CHARLES III to confirm/).fill("wrong phrase");
    await expect(dialog.getByRole("button", { name: /Confirm turn on/ })).toBeDisabled();
    await dialog.getByLabel(/Type KING CHARLES III to confirm/).fill("KING CHARLES III");
    await expect(dialog.getByRole("button", { name: /Confirm turn on/ })).toBeDisabled();
    await dialog.getByRole("checkbox", { name: "IGRS has approved this change" }).check({ force: true });
    await expect(dialog.getByRole("button", { name: /Confirm turn on/ })).toBeEnabled();
    await dialog.getByRole("button", { name: /Confirm turn on/ }).click();
    await expect(page.getByText("Project Blue Bridge is currently ON.")).toBeVisible();

    await tick();
    await tick();
    const home = await fetch(`${baseUrl()}/site/`);
    const html = await home.text();
    expect(html).toContain("TEST — ALERT:");

    // Turn it back off so it doesn't bleed into any other spec.
    await expect(dialog).toBeHidden();
    await switchControl.click({ force: true });
    const offDialog = page.getByRole("dialog");
    await expect(offDialog).toBeVisible();
    await expect(offDialog.getByRole("button", { name: /Confirm turn off/ })).toBeDisabled();
    await offDialog.getByLabel(/Type KING CHARLES III to confirm/).fill("KING CHARLES III");
    await offDialog.getByRole("checkbox", { name: "IGRS has approved this change" }).check({ force: true });
    await expect(offDialog.getByRole("button", { name: /Confirm turn off/ })).toBeEnabled();
    await offDialog.getByRole("button", { name: /Confirm turn off/ }).click();
    await expect(page.getByText("Project Blue Bridge is currently OFF.")).toBeVisible();
  });

  // I6: renamed from "...and reordered" — the old test added and saved a link but never
  // actually reordered anything. This one adds two links, moves the second one up with the
  // keyboard-operable Move button, saves, and reloads to confirm the new order persisted.
  test("resource links can be added, saved, and actually reordered", async ({ page, context }) => {
    await signInAs(context, "siteEditor");
    await page.goto(`${baseUrl()}/hub/website/links`);
    const before = await page.locator(".gcpe-links__item").count();

    const firstText = uniqueHeadline("First link");
    const secondText = uniqueHeadline("Second link");

    await page.getByRole("button", { name: "Add link" }).click();
    await page.getByLabel(`Link ${before + 1} text`).fill(firstText);
    await page.getByLabel(`Link ${before + 1} URL`).fill("https://www2.gov.bc.ca/immunize");
    await page.getByRole("button", { name: "Add link" }).click();
    await page.getByLabel(`Link ${before + 2} text`).fill(secondText);
    await page.getByLabel(`Link ${before + 2} URL`).fill("https://www2.gov.bc.ca/health");
    await page.getByRole("button", { name: "Save links" }).click();
    await expect(page.getByLabel(`Link ${before + 2} URL`)).toHaveValue("https://www2.gov.bc.ca/health");

    await page.getByRole("button", { name: `Move link ${before + 2} up` }).click();
    await expect(page.getByLabel(`Link ${before + 1} text`)).toHaveValue(secondText);
    await expect(page.getByLabel(`Link ${before + 2} text`)).toHaveValue(firstText);
    await page.getByRole("button", { name: "Save links" }).click();
    await expect(page.getByLabel(`Link ${before + 1} text`)).toHaveValue(secondText);

    // Persisted, not just a local reorder of unsaved state.
    await page.reload();
    await expect(page.getByLabel(`Link ${before + 1} text`)).toHaveValue(secondText);
    await expect(page.getByLabel(`Link ${before + 2} text`)).toHaveValue(firstText);
  });

  test("a file can be uploaded to the Website Files section and is reachable at its URL", async ({ page, context }) => {
    await signInAs(context, "siteEditor");
    await page.goto(`${baseUrl()}/hub/website/files`);

    // A minimal valid 1x1 PNG.
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const filePath = join(tmpdir(), `e2e-upload-${Date.now()}.png`);
    writeFileSync(filePath, pngBytes);

    await page.locator('input[type="file"]').setInputFiles(filePath);
    const link = page.getByRole("link", { name: /e2e-upload-.*\.png/ });
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    const fileRes = await fetch(`${baseUrl()}${href}`);
    expect(fileRes.status).toBe(200);
  });
});
