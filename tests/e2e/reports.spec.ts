// NoD parity spec §8 Reports and §10 item 14, end to end through the stack: every report opens for
// a NoD Viewer with axe clean; address CSVs are refused to a Viewer and download for an Editor with
// a BOM; a published release shows in Sends per release and in Distribution's totals.
import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import {
  apiCall, baseUrl, createApprovedAndPublished, expectNoSeriousA11yViolations, ROLE_LOGINS, signInAs, tick, uniqueHeadline,
} from "./playwright-support";

const REPORTS: [link: string, h1: string][] = [
  ["Active subscribers by list", "Active subscribers by list"],
  ["Recent unsubscribes", "Recent unsubscribes"],
  ["Sends per release", "Sends per release"],
  ["Daily digest runs", "Daily digest runs"],
  ["Distribution sent and bounced", "Distribution sent and bounced"],
];

test.describe("Reports", () => {
  test("a NoD Viewer opens every report and gets count-only CSVs; address CSVs are refused", async ({ page, context }) => {
    await signInAs(context, "nodViewer");
    await page.goto(`${baseUrl()}/hub/subscribers/reports`);
    await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "reports index");
    for (const [link, h1] of REPORTS) {
      await page.goto(`${baseUrl()}/hub/subscribers/reports`);
      await page.getByRole("link", { name: link }).click();
      await expect(page.getByRole("heading", { level: 1, name: h1 })).toBeVisible();
      await expect(page.getByText("Loading…")).toHaveCount(0);
      await expectNoSeriousA11yViolations(page, h1);
    }
    await page.goto(`${baseUrl()}/hub/subscribers/reports/unsubscribes`);
    await expect(page.getByRole("link", { name: "Download daily counts (CSV)" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download list with addresses (CSV)" })).toHaveCount(0);

    const viewer = await ROLE_LOGINS.nodViewer();
    for (const path of ["/nod/api/reports/unsubscribes.csv", "/nod/api/reports/subscribers-by-list/members.csv?list=all"]) {
      expect((await fetch(`${baseUrl()}${path}`, { headers: { cookie: viewer } })).status).toBe(403);
    }
  });

  test("an Editor downloads every active subscriber as a CSV with a BOM", async ({ page, context }) => {
    const admin = await ROLE_LOGINS.admin();
    const email = `report-${Date.now()}@example.test`;
    await apiCall(admin, "/nod/api/subscribers", { method: "POST", body: { email, lists: ["ministries:finance"] } });

    await signInAs(context, "nodEditor");
    await page.goto(`${baseUrl()}/hub/subscribers/reports/subscribers-by-list?list=all`);
    await expect(page.getByRole("heading", { level: 2, name: "Members: All active subscribers" })).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download members (CSV)" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^subscribers-all-\d{4}-\d{2}-\d{2}\.csv$/);
    const bytes = await readFile((await download.path())!);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString("utf8");
    expect(text.split("\r\n")[0]).toBe("﻿Email,Timing,Source,Registered (BC time)");
    expect(text).toMatch(new RegExp(`\\r\\n${email.replace(/[.]/g, "\\.")},As it happens,Added by staff,\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}\\r\\n`));
  });

  test("a published release appears in Sends per release and in Distribution's totals", async ({ page, context }) => {
    const admin = await ROLE_LOGINS.admin();
    await apiCall(admin, "/nod/api/subscribers", { method: "POST", body: { email: `report-aih-${Date.now()}@example.test`, lists: "all" } });
    const headline = uniqueHeadline("Reports end to end");
    await createApprovedAndPublished(await ROLE_LOGINS.editor(), { headline });
    await expect
      .poll(
        async () => {
          await tick();
          const r = await apiCall<{ items: { title: string; asItHappens: { handedOffNotBounced: number } }[] }>(admin, "/nod/api/reports/release-sends");
          return r.items.find((i) => i.title === headline)?.asItHappens.handedOffNotBounced ?? 0;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);

    await signInAs(context, "nodViewer");
    await page.goto(`${baseUrl()}/hub/subscribers/reports/release-sends`);
    await expect(page.getByRole("row", { name: new RegExp(headline) })).toBeVisible();
    await page.goto(`${baseUrl()}/hub/subscribers/reports/distribution`);
    await expect(page.getByRole("table", { name: "Totals" }).getByRole("row", { name: /^News On Demand \d+/ })).toBeVisible();
  });
});
