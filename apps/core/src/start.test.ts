import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { hashPassword } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb } from "../test/helpers";
import { startCore } from "./start";

describe("startCore", () => {
  let tdb: TestDatabase;

  afterAll(async () => {
    await tdb?.drop();
  });

  async function testEnv(): Promise<NodeJS.ProcessEnv> {
    tdb = await createCoreTestDb();
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
    await Promise.all(handle.closers.map((c) => c.close()));
  });

  it("runs each worker once without throwing on an empty DB", async () => {
    const handle = await startCore(await testEnv());
    for (const run of Object.values(handle.workers)) {
      await run();
    }
    await Promise.all(handle.closers.map((c) => c.close()));
  });

  it("closers close cleanly, with or without startLoops() having run", async () => {
    const handle = await startCore(await testEnv());
    await expect(Promise.all(handle.closers.map((c) => c.close()))).resolves.not.toThrow();

    const started = await startCore(await testEnv());
    started.startLoops();
    await expect(Promise.all(started.closers.map((c) => c.close()))).resolves.not.toThrow();
  });
});
