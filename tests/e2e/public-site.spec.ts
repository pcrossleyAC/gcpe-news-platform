// Spec §9 (E2E): publish → release, ministry, archive, home and feed pages exist; unpublishing
// removes the release page and its entries.
import { test, expect } from "@playwright/test";
import { EDITOR_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { apiCall, baseUrl, createApprovedAndPublished, loginForCookie, tickTwice } from "./playwright-support";
import type { ReleaseView } from "@gcpe/nrms-contract";

const text = async (path: string) => {
  const res = await fetch(`${baseUrl()}/site${path}`);
  return { status: res.status, body: res.status === 200 ? await res.text() : "" };
};

test("a published release appears on every page that lists it, and leaves them all when unpublished", async () => {
  const cookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
  const published = await createApprovedAndPublished(cookie);
  const key = published.key!;
  const post = (await (await fetch(`${baseUrl()}/api/Posts/${key}?api-version=1.0`)).json()) as { publishDate: string; ministryKeys: string[] };
  const month = post.publishDate.slice(0, 7);
  const ministry = post.ministryKeys[0]!.toLowerCase();
  const link = `/releases/${key}/`;

  expect(month).toMatch(/^\d{4}-\d{2}$/);
  expect((await text(link)).status).toBe(200);
  for (const path of ["/", `/ministries/${ministry}/`, `/archive/${month.slice(0, 4)}/${month.slice(5)}/`]) {
    expect((await text(path)).body, path).toContain(link);
  }
  expect((await text("/feed.xml")).body).toContain(link);
  expect((await text(`/ministries/${ministry}/feed.xml`)).body).toContain(link);
  expect((await text(`/sitemaps/${month}.xml`)).body).toContain(link);
  const releasePage = (await text(link)).body;
  expect(releasePage).toContain('<a class="skip-link" href="#main">');
  expect(releasePage).toContain('<meta name="robots" content="noindex, nofollow">');

  const current = await apiCall<ReleaseView>(cookie, `/nrms/api/releases/${published.id}`);
  await apiCall(cookie, `/nrms/api/releases/${published.id}/unpublish`, { method: "POST", body: { version: current.version } });
  await tickTwice();

  expect((await text(link)).status).toBe(404);
  for (const path of ["/", `/ministries/${ministry}/`, "/feed.xml", `/sitemaps/${month}.xml`]) {
    expect((await text(path)).body, path).not.toContain(link);
  }
});
