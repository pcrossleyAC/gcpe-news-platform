import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { hashPassword } from "@gcpe/auth";
import { createCalendarTestDb, SESSION_SECRET } from "../test/helpers";
import { calendarEnvSchema, startCalendar } from "./start";

describe("startCalendar", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
  });
  afterAll(() => tdb.drop());

  it("starts, serves health with Core and NRMS absent, and exposes dispatch and needsReferenceData", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "calendar-files-"));
    const handle = await startCalendar({
      DATABASE_URL: tdb.url,
      NODE_ENV: "test",
      // authFromEnv refuses to start with no way to sign in at all.
      LOCAL_ADMIN_ENABLED: "true",
      LOCAL_ADMIN_PASSWORD_HASH: await hashPassword("fixture-password-for-start-tests"),
      LOCAL_AUTH_SECRET: "x".repeat(32),
      SESSION_SECRET,
      STORAGE_DIR: storageDir,
    });
    try {
      expect((await request(handle.app).get("/health/ready")).status).toBe(200);
      expect(handle.port).toBe(3007);
      expect(handle.storageDir).toBe(storageDir);
      // Break-glass sign-in issues a bearer token, which can't use the Calendar: no endpoint for it.
      expect((await request(handle.app).post("/auth/local/token").send({ username: "admin", password: "x" })).status).toBe(404);
      expect(await handle.workers.needsReferenceData!()).toBe(true);
      expect(await handle.workers.dispatch!()).toEqual({ delivered: 0, retried: 0, dead: 0 });
      expect(await handle.workers.lockSweep!()).toEqual({ deleted: 0 });
    } finally {
      for (const c of [...handle.closeBeforeServer, ...handle.closers]) await c.close();
    }
  });

  it("reads the report settings, with defaults sized for SiteGround: one render at a time, 320 MB, 2 minutes, a 5 s wait", () => {
    const base = { DATABASE_URL: "postgres://user:pass@127.0.0.1:1/calendar" };
    expect(calendarEnvSchema.parse(base)).toMatchObject({ REPORT_CONCURRENCY: 1, REPORT_HEAP_MB: 320, REPORT_TIMEOUT_SECONDS: 120, REPORT_INLINE_WAIT_MS: 5000 });
    expect(calendarEnvSchema.parse({ ...base, REPORT_CONCURRENCY: "2", REPORT_INLINE_WAIT_MS: "0" })).toMatchObject({ REPORT_CONCURRENCY: 2, REPORT_INLINE_WAIT_MS: 0 });
    for (const bad of [{ REPORT_CONCURRENCY: "0" }, { REPORT_HEAP_MB: "10" }, { REPORT_INLINE_WAIT_MS: "60000" }]) expect(calendarEnvSchema.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false);
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

  it("keeps attachments under data/calendar-files by default, never inside the app (spec addendum §5.1)", () => {
    const parsed = calendarEnvSchema.parse({ DATABASE_URL: "postgres://user:pass@127.0.0.1:1/calendar" });
    expect(parsed.STORAGE_DIR).toBe(fileURLToPath(new URL("../../../data/calendar-files", import.meta.url)));
  });
});
