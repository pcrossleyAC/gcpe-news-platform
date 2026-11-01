import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { hashPassword } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb } from "../test/helpers";
import { createUser, createUserSchema } from "./services/users";
import { startCore } from "./start";

describe("startCore", () => {
  // Every DB created by testEnv() this test created, dropped in afterEach — a test
  // reassigning one `let tdb` and dropping only that one leaked every earlier DB it made
  // (P2-R29 fix round 1, item 2).
  const dbs: TestDatabase[] = [];

  afterEach(async () => {
    await Promise.all(dbs.splice(0).map((d) => d.drop()));
  });

  async function testEnv(): Promise<NodeJS.ProcessEnv> {
    const tdb = await createCoreTestDb();
    dbs.push(tdb);
    const hash = await hashPassword("fixture-password-for-start-tests");
    return {
      DATABASE_URL: tdb.url,
      LOCAL_ADMIN_ENABLED: "true",
      LOCAL_ADMIN_PASSWORD_HASH: hash,
      LOCAL_AUTH_SECRET: "x".repeat(32),
    };
  }

  it("returns a handle whose app answers health checks", async () => {
    const handle = await startCore(await testEnv());
    expect((await request(handle.app).get("/health/live")).status).toBe(200);
    expect((await request(handle.app).get("/health/ready")).status).toBe(200);
    await Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()));
  });

  it("has no closeBeforeServer closers (Core has nothing that must close before the http server)", async () => {
    const handle = await startCore(await testEnv());
    expect(handle.closeBeforeServer).toEqual([]);
    await Promise.all(handle.closers.map((c) => c.close()));
  });

  it("runs each worker once without throwing on an empty DB", async () => {
    const handle = await startCore(await testEnv());
    for (const run of Object.values(handle.workers)) {
      await run();
    }
    await Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()));
  });

  it("closers close cleanly, with or without startLoops() having run", async () => {
    const handle = await startCore(await testEnv());
    await expect(Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()))).resolves.not.toThrow();

    const started = await startCore(await testEnv());
    started.startLoops();
    await expect(Promise.all([...started.closeBeforeServer, ...started.closers].map((c) => c.close()))).resolves.not.toThrow();
  });

  it("refuses to start with Entra sign-in partly configured, naming what's missing", async () => {
    await expect(startCore({ ...(await testEnv()), ENTRA_CLIENT_ID: "core-client" })).rejects.toThrow(
      "Entra sign-in is partly configured: missing ENTRA_TENANT_ID, ENTRA_CLIENT_SECRET, PUBLIC_BASE_URL, SESSION_SECRET",
    );
  });

  // Production configuration T5 (2026-10-31): break-glass off with nobody able to sign in as a
  // Core Admin with Microsoft is said out loud at startup (never refused: that would take the site down).
  it("warns at startup when break-glass is off and no active Core Admin can sign in with Microsoft, and stops warning once one can", async () => {
    const tdb = await createCoreTestDb();
    dbs.push(tdb);
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: tdb.url,
      ENTRA_TENANT_ID: "11111111-1111-4111-8111-111111111111",
      AUTH_AUDIENCE: "api://core",
      ENTRA_CLIENT_ID: "core-client",
      ENTRA_CLIENT_SECRET: "core-secret",
      PUBLIC_BASE_URL: "https://news.example.invalid",
      SESSION_SECRET: "s".repeat(40),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = await startCore(env);
      for (const c of first.closers) await c.close();
      expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(/NO ADMIN: no active Core Admin can sign in with Microsoft/);
      warn.mockClear();
      await createUser(tdb.db, createUserSchema.parse({ email: "admin@example.test", displayName: "Admin", roles: ["Core.Admin"] }), []);
      const second = await startCore(env);
      for (const c of second.closers) await c.close();
      expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).not.toMatch(/NO ADMIN/);
    } finally {
      warn.mockRestore();
    }
  });
});
