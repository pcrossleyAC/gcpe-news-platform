import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb, waitForLockWaiter } from "../../test/helpers";
import { staffAuth } from "../../test/staff-auth";
import { createApp } from "../app";
import { subscriberHistory, subscribers } from "../db/schema";
import { lockAddress } from "../locks";
import type { MediaHubClient } from "../media-hub/client";
import type { MediaHubContact } from "../media-hub/contract";
import { addMediaMember, optOutMediaMemberships } from "../media-members";

const contact: MediaHubContact = {
  id: 42,
  firstName: "Sam",
  lastName: "Reporter",
  outlet: "Riverbend Gazette",
  emails: [{ ref: "personal", address: "sam@riverbend.example.test", kind: "personal", organization: null, preferred: true }],
  deletedAt: null,
};

describe("staff media-list routes", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let viewer: string, editor: string, nrmsEditor: string;
  const mediaHub = { search: vi.fn(), get: vi.fn(), changes: vi.fn() };

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const { auth, token } = await staffAuth();
    viewer = await token(["NoD.Viewer"]);
    editor = await token(["NoD.Editor"], "Erin Editor");
    nrmsEditor = await token(["NRMS.Editor"]);
    app = createApp({
      db: tdb.db,
      auth,
      eventSecrets: { nrms: "nrms-secret", core: "core-secret" },
      render: { siteUrl: "https://news.gov.bc.ca", bannerUrl: null },
      mediaHub: mediaHub as unknown as MediaHubClient,
    });
    await tdb.db.execute(sql`INSERT INTO lists (list_key, category, key, name) VALUES ('media-distribution-lists:budget','media-distribution-lists','budget','Budget')`);
  });
  afterAll(async () => tdb.drop());
  beforeEach(() => {
    mediaHub.search.mockReset();
    mediaHub.get.mockReset();
  });

  const as = (tok: string) => ({
    get: (p: string) => request(app).get(p).set("authorization", `Bearer ${tok}`),
    post: (p: string, body: object = {}) => request(app).post(p).set("authorization", `Bearer ${tok}`).send(body),
    del: (p: string) => request(app).delete(p).set("authorization", `Bearer ${tok}`),
  });

  it("a NoD Viewer reads lists, members, opt-outs and sync status, and is refused every write", async () => {
    for (const p of ["/api/media-lists", "/api/media-lists/budget/members", "/api/media-lists/budget/opted-out", "/api/media-hub/sync"]) {
      expect((await as(viewer).get(p)).status, p).toBe(200);
    }
    expect((await as(viewer).post("/api/media-lists/budget/members", { email: "v@example.test" })).status).toBe(403);
    expect((await as(viewer).del("/api/media-lists/budget/members/00000000-0000-0000-0000-000000000000")).status).toBe(403);
    expect((await as(viewer).post("/api/media-hub/contacts/search", { q: "Sam" })).status).toBe(403);
    expect((await as(viewer).get("/api/media-hub/contacts/42")).status).toBe(403);
    expect((await as(viewer).post("/api/media-hub/sync")).status).toBe(403);
    expect((await as(viewer).post("/api/media-members/00000000-0000-0000-0000-000000000000/resolve")).status).toBe(403);
    expect((await as(nrmsEditor).get("/api/media-lists")).status).toBe(403);
  });

  it("a NoD Editor adds and removes a member, recorded under their name", async () => {
    const added = await as(editor).post("/api/media-lists/budget/members", { email: "erin-adds@example.test" });
    expect(added.status).toBe(201);
    const removed = await as(editor).del(`/api/media-lists/budget/members/${added.body.subscriberId}`);
    expect(removed.status).toBe(204);
    const actions = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, added.body.subscriberId));
    expect(actions.map((h) => [h.action, h.actor])).toEqual(expect.arrayContaining([["media-list-added", "Erin Editor"], ["media-list-removed", "Erin Editor"]]));
  });

  it("search travels in a POST body with a fixed page size; the old GET path is gone", async () => {
    mediaHub.search.mockResolvedValue({ contacts: [contact], page: 2, pageSize: 25, total: 26 });
    const res = await as(editor).post("/api/media-hub/contacts/search", { q: " Sam ", page: 2 });
    expect(res.status).toBe(200);
    expect(mediaHub.search).toHaveBeenCalledWith("Sam", 2, 25);
    expect(res.body.contacts).toEqual([contact]);
    expect((await as(editor).post("/api/media-hub/contacts/search", {})).status).toBe(200);
    expect(mediaHub.search).toHaveBeenLastCalledWith("", 1, 25);
    expect((await as(editor).get("/api/media-hub/contacts?q=Sam")).status).toBe(404);
  });

  it("a failing search logs neither the term nor an address", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mediaHub.search.mockRejectedValue(new Error("boom while searching for secret-term pat@example.test"));
    const res = await as(editor).post("/api/media-hub/contacts/search", { q: "secret-term" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal error" });
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain("secret-term");
    expect(logged).not.toContain("@");
    spy.mockRestore();
  });

  it("GET /media-hub/contacts/:id returns a live contact; unknown, deleted or non-numeric ids are 404", async () => {
    mediaHub.get.mockImplementation(async (id: number) => (id === 42 ? contact : id === 43 ? { ...contact, id: 43, deletedAt: "2026-10-01T00:00:00Z" } : null));
    expect((await as(editor).get("/api/media-hub/contacts/42")).body).toEqual(contact);
    expect((await as(editor).get("/api/media-hub/contacts/43")).status).toBe(404);
    expect((await as(editor).get("/api/media-hub/contacts/44")).status).toBe(404);
    expect((await as(editor).get("/api/media-hub/contacts/abc")).status).toBe(404);
  });

  it("DELETE and resolve with a non-uuid subscriber id are 404s, never 500s", async () => {
    expect((await as(editor).del("/api/media-lists/budget/members/not-a-uuid")).status).toBe(404);
    expect((await as(editor).post("/api/media-members/not-a-uuid/resolve")).status).toBe(404);
  });

  it("the opted-out view lists who left the list by unsubscribing, newest first, and whether they're back", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "left@example.test", source: "manual-media" }, "t");
    await optOutMediaMemberships(tdb.db, subscriberId, "subscriber");
    const out = await as(viewer).get("/api/media-lists/budget/opted-out");
    expect(out.body.truncated).toBe(false);
    expect(out.body.items[0]).toMatchObject({ subscriberId, email: "left@example.test", member: false });
    await addMediaMember(tdb.db, "budget", { email: "left@example.test", source: "manual-media", confirmOptOut: true }, "t");
    expect((await as(viewer).get("/api/media-lists/budget/opted-out")).body.items[0]).toMatchObject({ subscriberId, member: true });
    expect((await as(viewer).get("/api/media-lists/nope/opted-out")).status).toBe(404);
  });

  it("clearing bouncing restarts the count and records bounce-resolved", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "bouncy@example.test", source: "manual-media" }, "t");
    await tdb.db.update(subscribers).set({ needsAttention: "bouncing", attentionAt: sql`now()` }).where(eq(subscribers.id, subscriberId));
    const res = await as(editor).post(`/api/media-members/${subscriberId}/resolve`, {});
    expect(res.status).toBe(200);
    const [row] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(row).toMatchObject({ needsAttention: null, attentionAt: null });
    expect(row!.bounceWindowFrom).not.toBeNull();
    const resolved = await tdb.db.select().from(subscriberHistory).where(and(eq(subscriberHistory.subscriberId, subscriberId), eq(subscriberHistory.action, "bounce-resolved")));
    expect(resolved.map((h) => h.actor)).toEqual(["Erin Editor"]);
  });

  it("resolve without a ref waits for the address lock", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "locked@example.test", source: "manual-media" }, "t");
    await tdb.db.update(subscribers).set({ needsAttention: "bouncing", attentionAt: sql`now()` }).where(eq(subscribers.id, subscriberId));
    let release!: () => void;
    let locked!: () => void;
    const lockHeld = new Promise<void>((r) => (locked = r));
    const holder = tdb.db.transaction(async (tx) => {
      await lockAddress(tx, "locked@example.test");
      locked();
      await new Promise<void>((r) => (release = r));
    });
    await lockHeld;
    const resolving = as(editor).post(`/api/media-members/${subscriberId}/resolve`, {}).then((r) => r.status);
    await waitForLockWaiter(tdb.db);
    expect((await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId)))[0]!.needsAttention).toBe("bouncing");
    release();
    await holder;
    expect(await resolving).toBe(200);
  });

  it("list summaries count members needing attention; members carry their ref and flag time", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "flagged@example.test", source: "manual-media" }, "t");
    await tdb.db.update(subscribers).set({ needsAttention: "bouncing", attentionAt: sql`now()` }).where(eq(subscribers.id, subscriberId));
    const lists = await as(viewer).get("/api/media-lists");
    expect(lists.body.find((l: { key: string }) => l.key === "budget").needsAttention).toBeGreaterThanOrEqual(1);
    const members = await as(viewer).get("/api/media-lists/budget/members");
    expect(members.body.find((m: { subscriberId: string }) => m.subscriberId === subscriberId)).toMatchObject({ needsAttention: "bouncing", mediaHubEmailRef: null });
    expect(members.body.find((m: { subscriberId: string }) => m.subscriberId === subscriberId).attentionAt).toEqual(expect.any(String));
  });

  it("the member and opt-out lookups have their indexes", async () => {
    const { rows } = await tdb.pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE indexname IN ('subscriptions_list_key_idx','subscriber_history_action_detail_at_idx') ORDER BY indexname",
    );
    expect(rows.map((r) => r.indexname)).toEqual(["subscriber_history_action_detail_at_idx", "subscriptions_list_key_idx"]);
  });
});
