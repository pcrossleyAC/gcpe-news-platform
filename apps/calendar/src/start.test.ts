import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { hashPassword } from "@gcpe/auth";
import { createCalendarTestDb, SESSION_SECRET } from "../test/helpers";
import { startCalendar } from "./start";

describe("startCalendar", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
  });
  afterAll(() => tdb.drop());

  it("starts, serves health with Core and NRMS absent, and exposes dispatch and needsReferenceData", async () => {
    const handle = await startCalendar({
      DATABASE_URL: tdb.url,
      NODE_ENV: "test",
      // authFromEnv refuses to start with no way to sign in at all.
      LOCAL_ADMIN_ENABLED: "true",
      LOCAL_ADMIN_PASSWORD_HASH: await hashPassword("fixture-password-for-start-tests"),
      LOCAL_AUTH_SECRET: "x".repeat(32),
      SESSION_SECRET,
    });
    try {
      expect((await request(handle.app).get("/health/ready")).status).toBe(200);
      expect(handle.port).toBe(3007);
      // Break-glass sign-in issues a bearer token, which can't use the Calendar: no endpoint for it.
      expect((await request(handle.app).post("/auth/local/token").send({ username: "admin", password: "x" })).status).toBe(404);
      expect(await handle.workers.needsReferenceData!()).toBe(true);
      expect(await handle.workers.dispatch!()).toEqual({ delivered: 0, retried: 0, dead: 0 });
      expect(await handle.workers.lockSweep!()).toEqual({ deleted: 0 });
    } finally {
      for (const c of [...handle.closeBeforeServer, ...handle.closers]) await c.close();
    }
  });
});
