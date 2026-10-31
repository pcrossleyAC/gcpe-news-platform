import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
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
      workflow: { timeZone: "America/Vancouver", countSubscribers: async () => 41_000, countMediaContacts: async () => 312 },
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
    expect(res.body).toEqual({ subscribers: { count: 41_000 }, mediaContacts: { count: 312 } });

    expect((await request(app()).get(`/api/releases/${id}/audience`).set("cookie", viewer)).status).toBe(403);
    expect((await request(app()).get("/api/releases/00000000-0000-4000-8000-0000000000ff/audience").set("cookie", editor)).status).toBe(404);
  });
});
