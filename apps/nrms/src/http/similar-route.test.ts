import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintSession } from "@gcpe/auth";
import { createNrmsTestDb, sampleCreate, seedTaxonomy } from "../../test/helpers";
import { createApp } from "../app";
import type { NewsApiSimilarClient, SimilarRequestBody } from "../clients";

const SECRET = "y".repeat(40) + "-nrms-similar-test";

describe("POST /api/releases/:id/similar", () => {
  let tdb: TestDatabase;
  let editor: string;
  let viewer: string;
  const sent: SimilarRequestBody[] = [];
  const client: NewsApiSimilarClient = {
    async similar(b) {
      sent.push(b);
      return {
        mode: b.mode,
        results: [{ key: "2026FIN0002-000002", headline: "Clinics budget", publishDate: "2026-10-03T10:00:00-07:00", leadMinistryKey: "FINANCE", url: "https://site.example.test/releases/2026FIN0002-000002", match: b.mode }],
      };
    },
  };
  const app = (similar?: { client: NewsApiSimilarClient; staffAi: boolean }) =>
    createApp({ db: tdb.db, auth: { session: { secret: SECRET } }, eventSecrets: {}, workflow: { timeZone: "America/Vancouver" }, similar });
  const cookie = async (roles: string[]) => `gcpe_session=${(await mintSession(SECRET, { id: "00000000-0000-4000-8000-00000000000b", name: "Pat", email: "pat@example.invalid", roles })).token}`;
  const create = async () => {
    const res = await request(app()).post("/api/releases").set("cookie", editor).set("x-gcpe-request", "1").send(sampleCreate);
    expect(res.status).toBe(201);
    return res.body as { id: string };
  };
  const find = (a: ReturnType<typeof app>, id: string, c = editor) => request(a).post(`/api/releases/${id}/similar`).set("cookie", c).set("x-gcpe-request", "1");

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
    editor = await cookie(["NRMS.Editor"]);
    viewer = await cookie(["NRMS.Viewer"]);
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it.each([
    [false, "text"],
    [true, "ai"],
  ] as const)("staffAi=%s: sends mode %s and answers with lead-ministry names", async (staffAi, mode) => {
    const { id } = await create();
    const res = await find(app({ client, staffAi }), id);
    expect(res.status).toBe(200);
    expect(sent.at(-1)).toMatchObject({ mode });
    expect(sent.at(-1)?.text).toContain("Weekend clinics open across B.C.");
    expect(res.body).toEqual({
      mode,
      results: [{ key: "2026FIN0002-000002", headline: "Clinics budget", publishDate: "2026-10-03T10:00:00-07:00", leadMinistry: "Finance", url: "https://site.example.test/releases/2026FIN0002-000002", match: mode }],
    });
  });

  it("writes nothing to the release's history", async () => {
    const { id } = await create();
    const log = async () => (await request(app()).get(`/api/releases/${id}/log?all=true`).set("cookie", editor)).body as unknown[];
    const before = await log();
    await find(app({ client, staffAi: true }), id);
    expect(await log()).toEqual(before);
  });

  it("403 for a viewer, 404 for an unknown release, 503 without a News API", async () => {
    const { id } = await create();
    expect((await find(app({ client, staffAi: false }), id, viewer)).status).toBe(403);
    expect((await find(app({ client, staffAi: false }), "00000000-0000-4000-8000-0000000000ff")).status).toBe(404);
    expect((await find(app(), id)).status).toBe(503);
  });

  it("502 with a generic message when the News API fails", async () => {
    const { id } = await create();
    const res = await find(app({ client: { similar: async () => { throw new Error("down"); } }, staffAi: false }), id);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Couldn't look for similar releases — try again." });
  });

  it("GET /config says whether the panel is available and whether staff AI is on", async () => {
    expect((await request(app()).get("/api/config").set("cookie", viewer)).body).toMatchObject({ similarAvailable: false, staffAi: false });
    expect((await request(app({ client, staffAi: true })).get("/api/config").set("cookie", viewer)).body).toMatchObject({ similarAvailable: true, staffAi: true });
  });
});
