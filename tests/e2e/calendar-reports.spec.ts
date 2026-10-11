// The 5g exit check end to end: each report as PDF from the list's current query, for several
// Calendar roles over the shared list fixture (A Health, B Health confidential, C Finance, D
// Finance confidential, E Finance confidential shared with Health, F Health deleted). The fixture's
// activities sit In the News (confirmed, not an events category); B, D and E are confidential with
// no Look Ahead section, so only Planning and 30/60/90 list them. The full role matrix runs on real
// Postgres in apps/calendar/src/reports/.
import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import type { ReportJobView } from "@gcpe/calendar-contract";
import { outlineOf, pdfPages } from "../../apps/calendar/test/pdf-text";
import { CAL_EDITOR_EMAIL, CAL_HQ_ADMIN_EMAIL, CAL_HQ_EDITOR_EMAIL, CAL_READONLY_EMAIL } from "./constants";
import { listFixture, listUrl, MAY, sessionOf, useCookie, type Key } from "./calendar-support";
import { apiCall, baseUrl, expectNoSeriousA11yViolations } from "./playwright-support";

/** Starts a report through the API, polls it, and returns its PDF's bytes. */
async function reportPdf(cookie: string, report: string, q: object): Promise<Uint8Array> {
  let job = await apiCall<ReportJobView>(cookie, `/calendar/api/reports/${report}`, { method: "POST", body: { q } });
  for (let i = 0; job.status === "running" && i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    job = await apiCall<ReportJobView>(cookie, `/calendar/api/reports/jobs/${job.id}`);
  }
  expect(job.status).toBe("ready");
  const res = await fetch(`${baseUrl()}/calendar/api/reports/jobs/${job.id}/pdf`, { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/pdf");
  return new Uint8Array(await res.arrayBuffer());
}

const ids = (outline: string[]) => outline.filter((t) => t.startsWith("id:")).map((t) => Number(t.slice(3)));

test.describe("the reports, as each role (spec addendum §3 row 5g, §10, §16 acceptance 10)", () => {
  const roles: [string, string, Key[]][] = [
    ["Editor (Health)", CAL_EDITOR_EMAIL, ["A", "B", "E"]],
    ["Read Only (Finance)", CAL_READONLY_EMAIL, ["C", "D", "E"]],
    ["HQ Editor", CAL_HQ_EDITOR_EMAIL, ["A", "C"]],
    ["HQ Administrator", CAL_HQ_ADMIN_EMAIL, ["A", "B", "C", "D", "E"]],
  ];
  for (const [who, email, keys] of roles) {
    test(`${who}: Planning and 30/60/90 list exactly the activities they can see, never a deleted one`, async () => {
      const f = await listFixture();
      const cookie = await sessionOf(email);
      const q = { filter: { ...MAY, quickSearch: f.tag } };
      const expected = keys.map((k) => f.ids[k]);
      const planning = await pdfPages(await reportPdf(cookie, "planning", q));
      expect(planning[0]!.size).toEqual([1008, 612]);
      expect(ids(outlineOf(planning))).toEqual(expected);
      expect(ids(outlineOf(await pdfPages(await reportPdf(cookie, "30-60-90", q))))).toEqual(expected);
    });
  }

  test("the Exec Look Ahead is refused below HQ Administrator, offered and built for one", async ({ page, context }) => {
    const f = await listFixture();
    const q = { filter: { ...MAY, quickSearch: f.tag } };
    const hqEditor = await sessionOf(CAL_HQ_EDITOR_EMAIL);
    const refused = await fetch(`${baseUrl()}/calendar/api/reports/exec-look-ahead`, {
      method: "POST", headers: { cookie: hqEditor, "x-gcpe-request": "1", "content-type": "application/json" }, body: JSON.stringify({ q }),
    });
    expect(refused.status).toBe(403);
    await useCookie(context, hqEditor);
    await page.goto(listUrl(q));
    await expect(page.getByRole("group", { name: "Reports (PDF)" }).getByRole("button")).toHaveText(["Look Ahead", "30/60/90", "Planning"]);
    const admin = await sessionOf(CAL_HQ_ADMIN_EMAIL);
    const exec = outlineOf(await pdfPages(await reportPdf(admin, "exec-look-ahead", q)));
    expect(exec).toContain("§ IN THE NEWS");
    expect(ids(exec)).toEqual([f.ids.A, f.ids.C]);
  });

  test("another user's report is not found", async () => {
    const f = await listFixture();
    const admin = await sessionOf(CAL_HQ_ADMIN_EMAIL);
    const job = await apiCall<ReportJobView>(admin, "/calendar/api/reports/planning", { method: "POST", body: { q: { filter: { ...MAY, quickSearch: f.tag } } } });
    const res = await fetch(`${baseUrl()}/calendar/api/reports/jobs/${job.id}/pdf`, { headers: { cookie: await sessionOf(CAL_EDITOR_EMAIL) } });
    expect(res.status).toBe(404);
  });

  test("HQ Editor: Look Ahead from the list's toolbar downloads the PDF for the current filter", async ({ page, context }) => {
    const f = await listFixture();
    await useCookie(context, await sessionOf(CAL_HQ_EDITOR_EMAIL));
    await page.goto(listUrl({ filter: { ...MAY, quickSearch: f.tag } }));
    await expect(page.locator(".gcpe-activity-title")).toHaveCount(2);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Look Ahead" }).click()]);
    expect(download.suggestedFilename()).toBe("LookAhead.pdf");
    const outline = outlineOf(await pdfPages(new Uint8Array(readFileSync(await download.path()))));
    // May 2031, In the News on Wednesday May 14 only; the other days have no Events. Awareness Dates
    // and the other later sections draw nothing when they hold no rows (no empty lower section).
    expect(outline.slice(0, 2)).toEqual(["§ INSIDE GOVERNMENT", "∅ Thursday, May 1, 2031"]);
    expect(outline.slice(outline.indexOf("§ OUTSIDE GOVERNMENT"))).toEqual(["§ OUTSIDE GOVERNMENT", "§ IN THE NEWS", `id:${f.ids.A}`, `id:${f.ids.C}`]);
    await expect(page.getByRole("status").filter({ hasText: "The Look Ahead report has downloaded." })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "the list after a report downloaded");
  });
});
