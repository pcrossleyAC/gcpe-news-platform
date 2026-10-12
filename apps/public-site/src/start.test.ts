import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { hashPassword } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";
import { createPublicSiteTestDb } from "../test/helpers";
import { startPublicSite } from "./start";

describe("startPublicSite", () => {
  // Every DB created by testEnv() this test created, dropped in afterEach — a test
  // reassigning one `let tdb` and dropping only that one leaked every earlier DB it made
  // (P2-R29 fix round 1, item 2).
  const dbs: TestDatabase[] = [];

  afterEach(async () => {
    await Promise.all(dbs.splice(0).map((d) => d.drop()));
  });

  async function testEnv(): Promise<NodeJS.ProcessEnv> {
    const tdb = await createPublicSiteTestDb();
    dbs.push(tdb);
    const outputDir = await mkdtemp(join(tmpdir(), "public-site-start-test-"));
    const hash = await hashPassword("fixture-password-for-start-tests");
    return {
      DATABASE_URL: tdb.url,
      // Closed port: a worker iteration on an empty DB never calls out, but the schema
      // still requires a valid URL.
      NEWS_API_URL: "http://127.0.0.1:1",
      OUTPUT_DIR: outputDir,
      // The site builder's own service token for the change feed: a local admin secret, since
      // no test here configures Entra client credentials.
      LOCAL_ADMIN_ENABLED: "true",
      LOCAL_ADMIN_PASSWORD_HASH: hash,
      LOCAL_AUTH_SECRET: "x".repeat(32),
    };
  }

  it("returns a handle whose app answers health checks", async () => {
    const handle = await startPublicSite(await testEnv());
    expect((await request(handle.app).get("/health/live")).status).toBe(200);
    expect((await request(handle.app).get("/health/ready")).status).toBe(200);
    await Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()));
  });

  it("has a sync worker and a background-loops closer", async () => {
    const handle = await startPublicSite(await testEnv());
    expect(Object.keys(handle.workers)).toEqual(["sync"]);
    expect(handle.closeBeforeServer.map((c) => c.name)).toEqual(["background loops"]);
    await Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()));
  });

  it("closers close cleanly, with or without startLoops() having run", async () => {
    const handle = await startPublicSite(await testEnv());
    await expect(Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()))).resolves.not.toThrow();

    const started = await startPublicSite(await testEnv());
    started.startLoops();
    await expect(Promise.all([...started.closeBeforeServer, ...started.closers].map((c) => c.close()))).resolves.not.toThrow();
  });

  // Without Entra client credentials or a local admin secret for the change feed's service
  // token, the site builder refuses to start rather than fail on its first tick.
  it("rejects with neither Entra client credentials nor local admin configured", async () => {
    const env = await testEnv();
    delete env.LOCAL_ADMIN_ENABLED;
    delete env.LOCAL_ADMIN_PASSWORD_HASH;
    delete env.LOCAL_AUTH_SECRET;
    await expect(startPublicSite(env)).rejects.toThrow(/NEWS_API_TOKEN_URL/);
  });

  it("starts with local admin configured", async () => {
    const handle = await startPublicSite(await testEnv());
    await Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()));
  });
});
