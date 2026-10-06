// Acceptance item 14: "'View PDF' and 'Email me a copy' produce a PDF and a text version."
import { test, expect } from "@playwright/test";
import { EDITOR_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { baseUrl, createApprovedAndPublished, loginForCookie, signInAs, tick, uniqueHeadline, waitForMessageWithSubject } from "./playwright-support";

test.describe("item 14: View PDF and Email me a copy", () => {
  test("View PDF downloads a PDF; Email me a copy sends the signed-in user a PDF and a text version", async ({ page, context }) => {
    const cookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const headline = uniqueHeadline("Emailable release");
    const published = await createApprovedAndPublished(cookie, { headline });

    await signInAs(context, "editor");
    await page.goto(`${baseUrl()}/hub/releases/${published.id}`);

    const pdfHref = await page.getByRole("link", { name: "View PDF" }).getAttribute("href");
    const pdfRes = await fetch(`${baseUrl()}${pdfHref}`, { headers: { cookie: await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!) } });
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get("content-type")).toBe("application/pdf");

    await page.getByRole("button", { name: "Email me a copy" }).click();
    await expect(page.getByText(`Sent to ${EDITOR_EMAIL}`)).toBeVisible();

    // "Sent to ..." only means NRMS handed the message to Distribution's queue
    // (apps/nod/src/distribution-client.ts's `send` POSTs to Distribution's /api/messages,
    // which enqueues and returns a batchId) — actually leaving via SMTP needs Distribution's
    // own worker, driven by /stack/tick's "distribution.send" step.
    await tick();
    const mail = await waitForMessageWithSubject(`FINAL - ${headline}`);
    expect(mail.to).toContain(EDITOR_EMAIL);
    expect(mail.attachmentNames.some((n) => n.endsWith(".pdf"))).toBe(true);
    expect(mail.attachmentNames.some((n) => n.endsWith(".txt"))).toBe(true);
  });
});
