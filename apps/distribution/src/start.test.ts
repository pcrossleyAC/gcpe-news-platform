import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { hashPassword } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";
import { createDistributionTestDb } from "../test/helpers";
import { startDistribution } from "./start";

describe("startDistribution", () => {
  // Every DB created by testEnv() this test created, dropped in afterEach — a test
  // reassigning one `let tdb` and dropping only that one leaked every earlier DB it made
  // (P2-R29 fix round 1, item 2).
  const dbs: TestDatabase[] = [];

  afterEach(async () => {
    await Promise.all(dbs.splice(0).map((d) => d.drop()));
  });

  async function testEnv(): Promise<NodeJS.ProcessEnv> {
    const tdb = await createDistributionTestDb();
    dbs.push(tdb);
    const hash = await hashPassword("fixture-password-for-start-tests");
    return {
      DATABASE_URL: tdb.url,
      // Closed port: a worker iteration on an empty DB claims nothing and never calls out.
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: "1",
      MAIL_FROM: "news@gov.bc.ca",
      MAIL_REDIRECT_TO: "qa@gov.bc.ca",
      LOCAL_ADMIN_ENABLED: "true",
      LOCAL_ADMIN_PASSWORD_HASH: hash,
      LOCAL_AUTH_SECRET: "x".repeat(32),
    };
  }

  it("returns a handle whose app answers health checks", async () => {
    const handle = await startDistribution(await testEnv());
    expect((await request(handle.app).get("/health/live")).status).toBe(200);
    expect((await request(handle.app).get("/health/ready")).status).toBe(200);
    await Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()));
  });

  it("has no closeBeforeServer closers (Distribution has nothing that must close before the http server)", async () => {
    const handle = await startDistribution(await testEnv());
    expect(handle.closeBeforeServer).toEqual([]);
    await Promise.all(handle.closers.map((c) => c.close()));
  });

  it("runs each worker once without throwing on an empty DB", async () => {
    const handle = await startDistribution(await testEnv());
    for (const run of Object.values(handle.workers)) {
      await run();
    }
    await Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()));
  });

  it("closers close cleanly, with or without startLoops() having run", async () => {
    const handle = await startDistribution(await testEnv());
    await expect(Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()))).resolves.not.toThrow();

    const started = await startDistribution(await testEnv());
    started.startLoops();
    await expect(Promise.all([...started.closeBeforeServer, ...started.closers].map((c) => c.close()))).resolves.not.toThrow();
  });
});
