import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintSession } from "@gcpe/auth";
import { createNrmsTestDb, sampleCreate, seedTaxonomy } from "../../test/helpers";
import { createApp } from "../app";

const SECRET = "y".repeat(40) + "-nrms-audience-test";

// Suite review R6: the Publish now and Schedule dialogs show about how many subscribers and media
// contacts a first publish reaches, worked out before anything is sent.
describe("GET /api/releases/:id/audience", () => {
  let tdb: TestDatabase;
  let editor: string;
  let viewer: string;
  const app = () =>
    createApp({
      db: tdb.db,
      auth: { session: { secret: SECRET } },
      eventSecrets: {},
      workflow: {
        timeZone: "America/Vancouver",
        releaseAudience: async () => ({ asItHappens: 40_000, digest: 1_200, mediaContacts: 312 }),
        correctionAudience: async () => ({ subscribers: 900, mediaContacts: 40, both: 2 }),
      },
    });
  const cookie = async (roles: string[]) => `gcpe_session=${(await mintSession(SECRET, { id: "00000000-0000-4000-8000-00000000000c", name: "Pat", email: "pat@example.invalid", roles })).token}`;

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
    editor = await cookie(["NRMS.Editor"]);
    viewer = await cookie(["NRMS.Viewer"]);
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("answers both counts for an editor; 403 for a viewer; 404 for an unknown release", async () => {
    const created = await request(app()).post("/api/releases").set("cookie", editor).set("x-gcpe-request", "1").send({ ...sampleCreate, mediaListKeys: ["regional"] });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;

    const res = await request(app()).get(`/api/releases/${id}/audience`).set("cookie", editor);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ asItHappens: { count: 40_000 }, digest: { count: 1_200 }, mediaContacts: { count: 312 } });

    expect((await request(app()).get(`/api/releases/${id}/audience`).set("cookie", viewer)).status).toBe(403);
    expect((await request(app()).get("/api/releases/00000000-0000-4000-8000-0000000000ff/audience").set("cookie", editor)).status).toBe(404);
  });

  // Owner decision 2026-10-31: "Also email it again?" — counts of who already got it, and Email
  // the correction for a live release. Editors only, like Publish now.
  it("email-again-audience and email-again: counts per tick, then republish asking for it; editors only; refused in plain words", async () => {
    const created = await request(app()).post("/api/releases").set("cookie", editor).set("x-gcpe-request", "1").send({ ...sampleCreate, mediaListKeys: ["regional"] });
    const id = (created.body as { id: string }).id;
    // Not out yet: nothing to email again.
    expect((await request(app()).get(`/api/releases/${id}/email-again-audience`).set("cookie", editor)).status).toBe(404);
    await tdb.db.execute(sql`UPDATE news_releases SET status = 'published', live = true, released_at = now(), publish_at = now(), atom_id = 'uuid:x', key = 'EMAIL-AGAIN-1', reference = 'NEWS-99999' WHERE id = ${id}`);

    const counts = await request(app()).get(`/api/releases/${id}/email-again-audience`).set("cookie", editor);
    expect(counts.status).toBe(200);
    expect(counts.body).toEqual({ subscribers: { count: 900 }, mediaContacts: { count: 40 }, both: 2 });
    expect((await request(app()).get(`/api/releases/${id}/email-again-audience`).set("cookie", viewer)).status).toBe(403);

    const version = (await request(app()).get(`/api/releases/${id}`).set("cookie", editor)).body.version as number;
    const post = (who: string, body: object) => request(app()).post(`/api/releases/${id}/email-again`).set("cookie", who).set("x-gcpe-request", "1").send(body);
    expect((await post(viewer, { version, subscribers: true, mediaLists: false })).status).toBe(403);
    const none = await post(editor, { version, subscribers: false, mediaLists: false });
    expect(none.status).toBe(422);
    expect(none.body.problems).toEqual(["Tick who to email it to again."]);
    expect((await post(editor, { version })).status).toBe(400);
    const ok = await post(editor, { version, subscribers: true, mediaLists: true });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "publishing", statusText: expect.any(String) });
    expect((await post(editor, { version, subscribers: true, mediaLists: true })).status).toBe(409);
  });
});
