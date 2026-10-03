import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { hashPassword } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../test/helpers";
import { startNod } from "./start";

describe("startNod", () => {
  let tdb: TestDatabase;

  afterAll(async () => {
    await tdb?.drop();
  });

  async function testEnv(): Promise<NodeJS.ProcessEnv> {
    tdb = await createNodTestDb();
    const hash = await hashPassword("fixture-password-for-start-tests");
    return {
      DATABASE_URL: tdb.url,
      // Closed port: a worker iteration on an empty DB claims nothing and never calls out,
      // but the schema still requires valid URLs.
      DISTRIBUTION_URL: "http://127.0.0.1:1",
      PUBLIC_SITE_URL: "http://127.0.0.1:1",
      MANAGE_URL: "http://127.0.0.1:1/manage",
      LOCAL_ADMIN_ENABLED: "true",
      LOCAL_ADMIN_PASSWORD_HASH: hash,
      LOCAL_AUTH_SECRET: "x".repeat(32),
    };
  }

  it("returns a handle whose app answers health checks", async () => {
    const handle = await startNod(await testEnv());
    expect((await request(handle.app).get("/health/live")).status).toBe(200);
    expect((await request(handle.app).get("/health/ready")).status).toBe(200);
    await Promise.all(handle.closers.map((c) => c.close()));
  });

  it("runs each worker once without throwing on an empty DB", async () => {
    const handle = await startNod(await testEnv());
    for (const run of Object.values(handle.workers)) {
      await run();
    }
    await Promise.all(handle.closers.map((c) => c.close()));
  });

  it("closers close cleanly, with or without startLoops() having run", async () => {
    const handle = await startNod(await testEnv());
    await expect(Promise.all(handle.closers.map((c) => c.close()))).resolves.not.toThrow();

    const started = await startNod(await testEnv());
    started.startLoops();
    await expect(Promise.all(started.closers.map((c) => c.close()))).resolves.not.toThrow();
  });
});
