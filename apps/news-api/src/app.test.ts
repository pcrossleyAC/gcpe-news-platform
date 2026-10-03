import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createApp } from "./app";
import { createNewsTestDb, EVENT_SECRETS, TZ } from "../test/helpers";

describe("app-level error handling", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    tdb = await createNewsTestDb();
    app = createApp({
      db: tdb.db,
      timeZone: TZ,
      eventSecrets: EVENT_SECRETS,
      subscribe: { baseUrl: "http://127.0.0.1:1", rateLimitPerMinute: 100 },
    });
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("returns 413 JSON (not 500) for a body over the 100kb limit", async () => {
    const res = await request(app)
      .post("/api/Subscribe/CreateNewsOnDemandEmailSubscriptionWithPreferences?api-version=1.0")
      .send({ big: "x".repeat(200 * 1024) });
    expect(res.status).toBe(413);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.body).toEqual({ error: "request entity too large" });
    expect(res.text).not.toMatch(/at \S+ \(|\.ts:\d+:\d+/);
  });
});
