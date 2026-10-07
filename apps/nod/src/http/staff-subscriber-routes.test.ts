import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { staffAuth } from "../../test/staff-auth";
import { createApp } from "../app";
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
    expect((await get(`/api/subscribers/${patId}/history`, viewer)).body).toEqual({ items: [] });
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
