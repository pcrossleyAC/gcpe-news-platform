import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { jsonErrorHandler } from "@gcpe/http-kit";
import { bcSettings } from "../../../../../packages/site-settings/src/fixtures";
import { createNewsTestDb } from "../../../test/helpers";
import { siteSettings } from "../../db/schema";
import { v2Routes } from "./routes";

describe("GET /api/v2/site-settings", () => {
  let tdb: TestDatabase;
  let app: express.Express;

  beforeAll(async () => {
    tdb = await createNewsTestDb();
    app = express();
    app.use("/api/v2", v2Routes({ db: tdb.db }));
    app.use(jsonErrorHandler({ logPrefix: "[news-api]" }));
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE site_settings");
  });

  it("answers 404 { error: 'not found' } with no-store before any settings are published", async () => {
    const res = await request(app).get("/api/v2/site-settings");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not found" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("answers 200 { revision, publishedAt, document } with no-store once stored", async () => {
    const document = bcSettings();
    await tdb.db.insert(siteSettings).values({ id: 1, revision: 3, publishedAt: new Date("2026-10-27T18:00:00.000Z"), document });
    const res = await request(app).get("/api/v2/site-settings");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ revision: 3, publishedAt: "2026-10-27T18:00:00.000Z", document: JSON.parse(JSON.stringify(document)) });
  });
});
