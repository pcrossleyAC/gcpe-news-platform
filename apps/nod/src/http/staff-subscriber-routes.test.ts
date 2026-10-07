import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { staffAuth } from "../../test/staff-auth";
import { createApp } from "../app";
import { subscribers } from "../db/schema";
import { privateErrors } from "./staff-subscriber-routes";

describe("staff subscriber routes — reads", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let viewer: string, nrmsEditor: string, admin: string, countOnly: string;
  let patId: string;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const { auth, token } = await staffAuth();
    viewer = await token(["NoD.Viewer"]);
    nrmsEditor = await token(["NRMS.Editor"]);
    admin = await token(["NoD.Admin"]);
    countOnly = await token(["NoD.SubscriberCount"]);
    app = createApp({ db: tdb.db, auth, eventSecrets: { nrms: "nrms-secret", core: "core-secret" }, render: { siteUrl: "https://news.gov.bc.ca", bannerUrl: null } });
    const r = await tdb.db.execute<{ id: string }>(sql`INSERT INTO subscribers (email, status) VALUES ('pat@example.test','active') RETURNING id`);
    patId = r.rows[0]!.id;
  });
  afterAll(async () => tdb.drop());

  const get = (path: string, tok?: string) => (tok ? request(app).get(path).set("authorization", `Bearer ${tok}`) : request(app).get(path));
  // Search terms never travel in a URL (a reverse proxy or browser history would record them,
  // and the term is usually an email address) — the client POSTs a JSON body instead.
  const search = (body: Record<string, unknown>, tok?: string) => {
    const req = request(app).post("/api/subscribers/search");
    return tok ? req.set("authorization", `Bearer ${tok}`).send(body) : req.send(body);
  };

  it("401 without a token; 403 for a non-NoD role; 200 for NoD.Viewer", async () => {
    expect((await search({})).status).toBe(401);
    expect((await search({}, nrmsEditor)).status).toBe(403);
    const ok = await search({ q: "pat", status: "active" }, viewer);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ total: 1, page: 1, pageSize: 50, items: [{ id: patId, email: "pat@example.test", status: "active" }] });
  });

  it("400 for an unknown status filter", async () => {
    expect((await search({ status: "bogus" }, viewer)).status).toBe(400);
  });

  it("an empty-string status or page counts as absent, not invalid", async () => {
    const res = await search({ status: "", page: "" }, viewer);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1 });
  });

  it("detail and history: 404 for a non-uuid or unknown id", async () => {
    expect((await get(`/api/subscribers/${patId}`, viewer)).body).toMatchObject({ id: patId, listKeys: [], mediaLists: [] });
    expect((await get(`/api/subscribers/${patId}/history`, viewer)).body).toEqual({ items: [], truncated: false });
    expect((await get("/api/subscribers/not-a-uuid", viewer)).status).toBe(404);
    expect((await get("/api/subscribers/00000000-0000-0000-0000-000000000000/history", viewer)).status).toBe(404);
  });

  it("the existing count route still wins over /subscribers/:id", async () => {
    // Were /subscribers/:id reached first, "count" would fail the uuid check and answer 404.
    const res = await get("/api/subscribers/count?lists=", admin);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 0 });
  });

  it("privateErrors logs no address: an unexpected error is a bare 500 and only a label is logged", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bare = express();
    bare.get("/boom", privateErrors(async () => {
      throw Object.assign(new Error('Failed query: select … params: pat@example.test'), { cause: { code: "XX000" } });
    }));
    const res = await request(bare).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal error" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("@");
    expect(JSON.stringify(spy.mock.calls)).toContain("XX000");
    spy.mockRestore();
  });

  it("a malformed search body is a safe 400, never echoing it back", async () => {
    const res = await request(app)
      .post("/api/subscribers/search")
      .set("authorization", `Bearer ${viewer}`)
      .set("content-type", "application/json")
      .send("{not json, secret@example.test");
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("secret@example.test");
    expect(JSON.stringify(res.body)).not.toContain("@");
  });

  it("an oversized search body is rejected at the body parser, never echoing it back", async () => {
    const res = await search({ q: `big-${"x".repeat(200_000)}-secret@example.test` }, viewer);
    expect(res.status).toBe(413);
    expect(JSON.stringify(res.body)).not.toContain("secret@example.test");
  });

  it('a "100%" search matches that literal substring, not as a wildcard', async () => {
    await tdb.db.execute(sql`
      INSERT INTO subscribers (email, status) VALUES
        ('deal100%off@example.test','active'),
        ('deal100xoff@example.test','active')`);
    const res = await search({ q: "100%" }, viewer);
    expect(res.status).toBe(200);
    expect(res.body.items.map((s: { email: string }) => s.email)).toEqual(["deal100%off@example.test"]);
  });

  it("403s every read route for a NoD.SubscriberCount-only token", async () => {
    expect((await search({}, countOnly)).status).toBe(403);
    expect((await get(`/api/subscribers/${patId}`, countOnly)).status).toBe(403);
    expect((await get(`/api/subscribers/${patId}/history`, countOnly)).status).toBe(403);
    expect((await get("/api/subscriber-list-options", countOnly)).status).toBe(403);
  });
});

describe("staff subscriber routes — writes", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let viewer: string, editor: string, admin: string;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const { auth, token } = await staffAuth();
    [viewer, editor, admin] = await Promise.all([token(["NoD.Viewer"]), token(["NoD.Editor"]), token(["NoD.Admin"])]);
    app = createApp({ db: tdb.db, auth, eventSecrets: { nrms: "nrms-secret", core: "core-secret" }, render: { siteUrl: "https://news.gov.bc.ca", bannerUrl: null } });
    await tdb.db.execute(sql`INSERT INTO lists (list_key, category, key, name) VALUES ('ministries:health','ministries','health','Health')`);
  });
  afterAll(async () => tdb.drop());

  const send = (method: "post" | "put" | "delete", path: string, tok: string, body?: unknown) =>
    request(app)[method](path).set("authorization", `Bearer ${tok}`).send(body as object);

  it("Viewer can't write; Editor and Admin can add", async () => {
    expect((await send("post", "/api/subscribers", viewer, { email: "v@example.test", lists: "all" })).status).toBe(403);
    expect((await send("post", "/api/subscribers", editor, { email: "e@example.test", lists: ["ministries:health"], digest: true })).status).toBe(201);
    expect((await send("post", "/api/subscribers", admin, { email: "a@example.test", lists: "all" })).status).toBe(201);
  });

  it("Viewer can't change, delete or bulk-act on a subscriber either", async () => {
    const { body: { id } } = await send("post", "/api/subscribers", editor, { email: "viewed@example.test", lists: "all" });
    expect((await send("put", `/api/subscribers/${id}/preferences`, viewer, { asItHappens: true, digest: false, allNews: true, listKeys: [] })).status).toBe(403);
    expect((await send("post", `/api/subscribers/${id}/status`, viewer, { status: "disabled" })).status).toBe(403);
    expect((await send("post", `/api/subscribers/${id}/email`, viewer, { email: "elsewhere@example.test" })).status).toBe(403);
    expect((await send("delete", `/api/subscribers/${id}`, viewer)).status).toBe(403);
    expect((await send("post", "/api/subscribers/bulk", viewer, { action: "delete", ids: [id] })).status).toBe(403);
    const [row] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, id));
    expect(row).toMatchObject({ email: "viewed@example.test", status: "active" });
  });

  it("adding an existing address answers 409 with that subscriber's id; neither timing is 400", async () => {
    const first = await send("post", "/api/subscribers", editor, { email: "dupe@example.test", lists: "all" });
    const dup = await send("post", "/api/subscribers", editor, { email: "DUPE@example.test", lists: "all" });
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ error: "subscriber exists", id: first.body.id });
    expect((await send("post", "/api/subscribers", editor, { email: "none@example.test", lists: "all", asItHappens: false })).status).toBe(400);
  });

  it("preferences, status, email, delete and bulk round trip with their error shapes", async () => {
    const { body: { id } } = await send("post", "/api/subscribers", editor, { email: "rt@example.test", lists: "all" });
    expect((await send("put", `/api/subscribers/${id}/preferences`, editor, { asItHappens: false, digest: false, allNews: true, listKeys: [] })).body).toEqual({ error: "Choose As It Happens, Daily Digest, or both." });
    expect((await send("put", `/api/subscribers/${id}/preferences`, editor, { asItHappens: true, digest: false, allNews: false, listKeys: ["ministries:health"] })).body).toEqual({ ok: true });
    expect((await send("post", `/api/subscribers/${id}/status`, editor, { status: "disabled" })).body).toEqual({ changed: true });
    expect((await send("post", `/api/subscribers/${id}/email`, editor, { email: "dupe@example.test" })).body).toMatchObject({ error: "email-taken" });
    expect((await send("post", `/api/subscribers/${id}/email`, editor, { email: "rt2@example.test" })).body).toEqual({ changed: true });
    expect((await send("delete", `/api/subscribers/${id}`, editor)).body).toEqual({ changed: true });
    expect((await send("post", `/api/subscribers/${id}/status`, editor, { status: "active" })).body).toEqual({ error: "status", status: "deleted" });
    expect((await send("post", "/api/subscribers/bulk", editor, { action: "delete", ids: [id] })).body).toEqual({ changed: 0, skipped: [{ id, reason: "unchanged" }] });
    expect((await send("post", "/api/subscribers/bulk", editor, { action: "delete", ids: Array.from({ length: 201 }, () => randomUUID()) })).status).toBe(400);
    expect((await send("post", "/api/subscribers/not-a-uuid/status", editor, { status: "active" })).status).toBe(404);
  });

  it("add and change email cap an address at 150 characters, the same as the public journey", async () => {
    const address = (length: number) => `${"a".repeat(60)}@${"b".repeat(length - 66)}.test`;
    expect(address(151)).toHaveLength(151);
    expect((await send("post", "/api/subscribers", editor, { email: address(151), lists: "all" })).status).toBe(400);
    const added = await send("post", "/api/subscribers", editor, { email: ` ${address(150).toUpperCase()} `, lists: "all" });
    expect(added.status).toBe(201);
    const [row] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, added.body.id));
    expect(row!.email).toBe(address(150));
    const { body: { id } } = await send("post", "/api/subscribers", editor, { email: "cap@example.test", lists: "all" });
    expect((await send("post", `/api/subscribers/${id}/email`, editor, { email: address(151).replace("a@", "c@") })).status).toBe(400);
  });
});
