import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { staffAuth } from "../../test/staff-auth";
import { createApp } from "../app";
import type { DistributionClient } from "../distribution-client";

describe("operations routes", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let admin: string, editor: string;
  const distribution = {
    send: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({ paused: false }),
    setPaused: vi.fn(),
    uploadBounce: vi.fn(),
    bounceSummary: vi.fn(),
    bounceSource: vi.fn().mockResolvedValue({ source: "fake" }),
  } as unknown as DistributionClient;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const { auth, token } = await staffAuth();
    admin = await token(["NoD.Admin"], "Avery Admin");
    editor = await token(["NoD.Editor"]);
    app = createApp({
      db: tdb.db,
      auth,
      eventSecrets: { nrms: "nrms-secret", core: "core-secret" },
      render: { siteUrl: "https://news.gov.bc.ca", bannerUrl: null },
      distribution,
      bounceSummaryFallback: "server@example.test",
    });
  });
  afterAll(async () => tdb.drop());

  it("Admin only", async () => {
    expect((await request(app).get("/api/operations").set("authorization", `Bearer ${editor}`)).status).toBe(403);
    expect((await request(app).put("/api/operations/bounce-summary-address").set("authorization", `Bearer ${editor}`).send({ address: null })).status).toBe(403);
  });

  it("reads the whole status", async () => {
    const res = await request(app).get("/api/operations").set("authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      nod: { paused: false, lastDigestCutoff: null },
      distribution: { paused: false },
      bounceSource: "fake",
      bounceSummary: { address: "server@example.test", from: "server" },
      softCodesCounted: [],
    });
  });

  it("sets, validates and clears the summary address; an empty string clears it", async () => {
    const put = (body: object) => request(app).put("/api/operations/bounce-summary-address").set("authorization", `Bearer ${admin}`).send(body);
    expect((await put({ address: "not an email" })).status).toBe(400);
    const set = await put({ address: " Summary@Example.test " });
    expect(set.body).toEqual({ changed: true, bounceSummary: { address: "Summary@Example.test", from: "setting" } });
    const cleared = await put({ address: "" });
    expect(cleared.body).toEqual({ changed: true, bounceSummary: { address: "server@example.test", from: "server" } });
  });

  it("sets the soft codes counted as hard; Admin only; rejects anything but 4.x.x", async () => {
    const put = (token: string, body: object) => request(app).put("/api/operations/bounce-soft-codes").set("authorization", `Bearer ${token}`).send(body);
    expect((await put(editor, { codes: [] })).status).toBe(403);
    expect((await put(admin, { codes: ["5.1.1"] })).status).toBe(400);
    expect((await put(admin, { codes: ["452"] })).status).toBe(400);
    expect((await put(admin, { codes: "4.2.2" })).status).toBe(400);
    expect((await put(admin, { codes: Array.from({ length: 51 }, (_, i) => `4.2.${i}`) })).status).toBe(400);
    const ok = await put(admin, { codes: ["4.4.7", "4.2.2"] });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ changed: true, softCodesCounted: ["4.2.2", "4.4.7"] });
    await put(admin, { codes: [] });
  });
});
