// Acceptance items 6-8 (docs/superpowers/specs/2026-10-05-nod-distribution-parity-design.md §10):
// a media-list send reaches each member once, full text, with the standard footer and one-click
// unsubscribe (C63); adding a member from the fake Media Hub, syncing an email change and a
// deletion; and the legacy membership endpoint reporting a member's media lists.
import { test, expect } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USERNAME, EDITOR_EMAIL, MEMBERSHIP_API_PASSWORD, MEMBERSHIP_API_USERNAME, TEST_USER_PASSWORDS } from "./constants";
import {
  apiCall,
  baseUrl,
  createApprovedAndPublished,
  fetchSentMessages,
  loginForCookie,
  tick,
  uniqueHeadline,
  waitForMessageTo,
} from "./playwright-support";

const linkIn = (text: string | null) => text!.match(/https?:\/\/\S+\/subscribe\/manage\/\?token=[A-Za-z0-9_-]+/)![0];
const toBaseUrl = (url: string) => url.replace(/^https?:\/\/[^/]+/, baseUrl());

interface MediaListSummary {
  listKey: string;
  key: string;
  active: boolean;
}

interface MediaMember {
  subscriberId: string;
  email: string;
}

interface MediaHubEmail {
  ref: string;
  address: string;
  kind: "personal" | "workplace";
}

interface MediaHubContact {
  id: number;
  emails: MediaHubEmail[];
}

/** `POST /nrms/api/media-lists` (tolerating 409 -- both specs in this file share one list, the
 * same hedge `playwright-support.ts`'s `ensureSubscriber` uses for a subscriber surviving from a
 * prior test), then ticks until `nrms.dispatch` has carried the `media_list.created` event
 * through to NoD's own mirror (`GET /nod/api/media-lists`) -- list creation and the mirror are
 * two separate apps, joined only by the stack's tick. */
async function createMirroredMediaList(adminCookie: string, key: string, displayName: string, timeoutMs = 10_000): Promise<void> {
  const res = await fetch(`${baseUrl()}/nrms/api/media-lists`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-GCPE-Request": "1", cookie: adminCookie },
    body: JSON.stringify({ key, displayName }),
  });
  if (res.status !== 201 && res.status !== 409) throw new Error(`media list creation failed: ${res.status} ${await res.text()}`);

  const listKey = `media-distribution-lists:${key}`;
  const start = Date.now();
  for (;;) {
    await tick();
    const lists = await apiCall<MediaListSummary[]>(adminCookie, "/nod/api/media-lists");
    if (lists.some((l) => l.listKey === listKey && l.active)) return;
    if (Date.now() - start > timeoutMs) throw new Error(`media list ${listKey} was never mirrored to NoD within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function addManualMember(adminCookie: string, key: string, email: string): Promise<string> {
  const { subscriberId } = await apiCall<{ subscriberId: string }>(adminCookie, `/nod/api/media-lists/${key}/members`, { method: "POST", body: { email } });
  return subscriberId;
}

async function listMembers(adminCookie: string, key: string): Promise<MediaMember[]> {
  return apiCall<MediaMember[]>(adminCookie, `/nod/api/media-lists/${key}/members`);
}

/** Calls `POST /nod/api/media-hub/sync` until the whole feed has been processed -- a run can
 * span more than one bounded call (global constraints: the lease-based sync). */
async function runSyncToCompletion(adminCookie: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const outcome = await apiCall<{ done: boolean }>(adminCookie, "/nod/api/media-hub/sync", { method: "POST" });
    if (outcome.done) return;
    if (Date.now() - start > timeoutMs) throw new Error(`media hub sync never finished within ${timeoutMs}ms`);
  }
}

async function membershipLookup(email: string): Promise<{ status: number; body: { SubscribedCategories: Record<string, string[]> } }> {
  const res = await fetch(`${baseUrl()}/nod/Subscribe/SubscriberInformation?emailAddress=${encodeURIComponent(email)}`, {
    headers: { authorization: `Basic ${Buffer.from(`${MEMBERSHIP_API_USERNAME}:${MEMBERSHIP_API_PASSWORD}`).toString("base64")}` },
  });
  return { status: res.status, body: (await res.json()) as { SubscribedCategories: Record<string, string[]> } };
}

// Matches Media Hub's own slug parser (membership.test.ts: /^(\d{3})-(\d|[a-z])-(.+)$/).
const LIST_KEY = "999-e-e2e-desk";

test.describe("items 6-8: media lists end to end", () => {
  test("a release with media lists reaches each member once, with the footer and one-click unsubscribe; an advisory has no Gov News subject or READ MORE", async ({ request }) => {
    const adminCookie = await loginForCookie(ADMIN_USERNAME, ADMIN_PASSWORD);
    const editorCookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    await createMirroredMediaList(adminCookie, LIST_KEY, "E2E Media Desk");

    const memberA = `media-a-${Date.now()}@example.test`;
    await addManualMember(adminCookie, LIST_KEY, memberA);

    const headline = uniqueHeadline("Weekend clinics media release");
    await createApprovedAndPublished(editorCookie, { headline, mediaListKeys: [LIST_KEY] });

    const subject = `BC Gov News - ${headline}`;
    const mail = await waitForMessageTo(subject, memberA);
    expect(mail.to).toEqual([memberA]);
    expect(mail.text).toContain("Clinics will open on weekends starting in November");

    // The footer's manage link and RFC 8058 one-click unsubscribe, exactly as every other
    // subscriber email (global constraints, "Media emails": "no media branch for links").
    expect(linkIn(mail.text)).toMatch(/\/subscribe\/manage\/\?token=/);
    expect(mail.headers["list-unsubscribe-post"]).toBe("List-Unsubscribe=One-Click");
    const unsubscribeUrl = toBaseUrl(mail.headers["list-unsubscribe"]!.replace(/^<|>$/g, ""));
    const oneClick = await request.post(unsubscribeUrl, { form: { "List-Unsubscribe": "One-Click" } });
    expect(oneClick.status()).toBe(200);
    expect(await oneClick.json()).toBe(true);

    expect((await listMembers(adminCookie, LIST_KEY)).some((m) => m.email === memberA)).toBe(false);

    // A second member, added after the one-click above, proves the list still sends -- the
    // first member's opt-out didn't take the list itself down.
    const memberB = `media-b-${Date.now()}@example.test`;
    await addManualMember(adminCookie, LIST_KEY, memberB);

    const headline2 = uniqueHeadline("Weekend clinics follow-up release");
    await createApprovedAndPublished(editorCookie, { headline: headline2, mediaListKeys: [LIST_KEY] });
    const subject2 = `BC Gov News - ${headline2}`;
    await waitForMessageTo(subject2, memberB);

    // The opted-out member gets nothing further, media or public, from this list.
    const stillNothing = (await fetchSentMessages()).filter((m) => m.subject === subject2 && m.to.includes(memberA));
    expect(stillNothing).toHaveLength(0);

    // An advisory: the bare title as subject (never "BC Gov News - ..."), and no "Read more:"
    // link (global constraints, "Media emails": omitted for advisories).
    const advisoryHeadline = uniqueHeadline("Media advisory event reminder");
    await createApprovedAndPublished(editorCookie, {
      type: "advisory",
      headline: advisoryHeadline,
      mediaListKeys: [LIST_KEY],
      sectors: [],
      themes: [],
      tags: [],
    });
    const advisoryMail = await waitForMessageTo(advisoryHeadline, memberB);
    expect(advisoryMail.subject).toBe(advisoryHeadline);
    expect(advisoryMail.text).not.toContain("Read more:");
  });

  test("adding a member from the fake Media Hub, syncing an email change and a deletion, and the legacy membership endpoint", async () => {
    const adminCookie = await loginForCookie(ADMIN_USERNAME, ADMIN_PASSWORD);
    await createMirroredMediaList(adminCookie, LIST_KEY, "E2E Media Desk");

    const search = await apiCall<{ contacts: MediaHubContact[] }>(adminCookie, "/nod/api/media-hub/contacts?q=");
    const contact = search.contacts[0];
    if (!contact) throw new Error("fake Media Hub returned no contacts to search");
    const workplaceEmail = contact.emails.find((e) => e.kind === "workplace");
    if (!workplaceEmail) throw new Error(`contact ${contact.id} has no workplace email`);

    const { subscriberId } = await apiCall<{ subscriberId: string }>(adminCookie, `/nod/api/media-lists/${LIST_KEY}/members`, {
      method: "POST",
      body: { mediaHubContactId: contact.id, emailRef: workplaceEmail.ref },
    });

    const changedAddress = `changed-${Date.now()}@example.test`;
    await apiCall(adminCookie, `/fake-media-hub/__fake/contacts/${contact.id}/email`, { method: "POST", body: { ref: workplaceEmail.ref, address: changedAddress } });
    await runSyncToCompletion(adminCookie);

    const afterSync = await listMembers(adminCookie, LIST_KEY);
    expect(afterSync.find((m) => m.subscriberId === subscriberId)?.email).toBe(changedAddress);

    // The legacy Membership tab's own endpoint (C55), Basic Auth, reports this member's media
    // lists under their current (post-sync) address.
    const lookup = await membershipLookup(changedAddress);
    expect(lookup.status).toBe(200);
    expect(lookup.body.SubscribedCategories["media-distribution-lists"]).toContain(LIST_KEY);

    await apiCall(adminCookie, `/fake-media-hub/__fake/contacts/${contact.id}/delete`, { method: "POST" });
    await runSyncToCompletion(adminCookie);

    const afterDelete = await listMembers(adminCookie, LIST_KEY);
    expect(afterDelete.find((m) => m.subscriberId === subscriberId)).toBeUndefined();
  });

  test("an unknown email gets empty categories, and wrong credentials get 401", async () => {
    const unknown = await membershipLookup(`no-such-member-${Date.now()}@example.test`);
    expect(unknown.status).toBe(200);
    expect(unknown.body.SubscribedCategories).toEqual({});

    const res = await fetch(`${baseUrl()}/nod/Subscribe/SubscriberInformation?emailAddress=someone@example.test`, {
      headers: { authorization: `Basic ${Buffer.from(`${MEMBERSHIP_API_USERNAME}:wrong-password`).toString("base64")}` },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
  });
});
