import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

  it("refuses to start when the tenant file has no calendar section (spec addendum §5.1)", async () => {
    const bc = JSON.parse(await readFile(fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url)), "utf8")) as Record<string, unknown>;
    delete bc.calendar;
    const dir = await mkdtemp(join(tmpdir(), "calendar-tenant-"));
    const file = join(dir, "no-calendar.json");
    await writeFile(file, JSON.stringify(bc));
    await expect(
      startCalendar({
        DATABASE_URL: tdb.url,
        NODE_ENV: "test",
        LOCAL_ADMIN_ENABLED: "true",
        LOCAL_ADMIN_PASSWORD_HASH: await hashPassword("fixture-password-for-start-tests"),
        LOCAL_AUTH_SECRET: "x".repeat(32),
        SESSION_SECRET,
        TENANT_CONFIG: file,
      }),
    ).rejects.toThrow(/has no "calendar" section/);
  });
});
