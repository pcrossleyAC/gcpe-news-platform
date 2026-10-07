import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { staffAuth } from "../../test/staff-auth";
import { createApp } from "../app";

describe("staff list routes", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let viewer: string, editor: string, admin: string;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const { auth, token } = await staffAuth();
    viewer = await token(["NoD.Viewer"]);
    editor = await token(["NoD.Editor"]);
    admin = await token(["NoD.Admin"], "Avery Admin");
    app = createApp({ db: tdb.db, auth, eventSecrets: { nrms: "nrms-secret", core: "core-secret" }, render: { siteUrl: "https://news.gov.bc.ca", bannerUrl: null } });
    await tdb.db.execute(sql`
      INSERT INTO lists (list_key, category, key, name) VALUES ('ministries:health','ministries','health','Health'),
        ('media-distribution-lists:budget','media-distribution-lists','budget','Budget')`);
  });
  afterAll(async () => tdb.drop());

  const put = (tok: string, p: string, body: object) => request(app).put(p).set("authorization", `Bearer ${tok}`).send(body);

  it("NoD Viewers read the view; only Admins change it", async () => {
    const view = await request(app).get("/api/list-categories").set("authorization", `Bearer ${viewer}`);
    expect(view.status).toBe(200);
    expect(view.body.categories.find((c: { key: string }) => c.key === "ministries").lists[0]).toMatchObject({ listKey: "ministries:health", enabled: true, subscribers: 0 });
    expect((await put(viewer, "/api/lists/ministries:health", { enabled: false })).status).toBe(403);
    expect((await put(editor, "/api/lists/ministries:health", { enabled: false })).status).toBe(403);
    const ok = await put(admin, "/api/lists/ministries%3Ahealth", { enabled: false });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ changed: true });
  });

  it("maps errors: 400 bad body, 404 unknown, 409 media and stale order", async () => {
    expect((await put(admin, "/api/lists/ministries:health", { enabled: "no" })).status).toBe(400);
    expect((await put(admin, "/api/lists/ministries:nope", { enabled: true })).status).toBe(404);
    expect((await put(admin, "/api/list-categories/nope", { enabled: true })).status).toBe(404);
    const media = await put(admin, "/api/lists/media-distribution-lists:budget", { enabled: false });
    expect([media.status, media.body]).toEqual([409, { error: "managed-in-nrms" }]);
    const stale = await put(admin, "/api/list-categories/order", { keys: ["ministries"] });
    expect([stale.status, stale.body]).toEqual([409, { error: "order-out-of-date" }]);
    const listOrder = await put(admin, "/api/list-categories/ministries/list-order", { listKeys: ["ministries:health"] });
    expect([listOrder.status, listOrder.body]).toEqual([200, { ok: true }]);
  });
});
