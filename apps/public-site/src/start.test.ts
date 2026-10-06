import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
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
    return {
      DATABASE_URL: tdb.url,
      // Closed port: a worker iteration on an empty DB never calls out, but the schema
      // still requires a valid URL.
      NEWS_API_URL: "http://127.0.0.1:1",
      OUTPUT_DIR: outputDir,
    };
  }

  it("returns a handle whose app answers health checks", async () => {
    const handle = await startPublicSite(await testEnv());
    expect((await request(handle.app).get("/health/live")).status).toBe(200);
    expect((await request(handle.app).get("/health/ready")).status).toBe(200);
    await Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()));
  });

  it("has no workers and no closeBeforeServer closers (Public Site has no background loops)", async () => {
    const handle = await startPublicSite(await testEnv());
    expect(Object.keys(handle.workers)).toEqual([]);
    expect(handle.closeBeforeServer).toEqual([]);
    await Promise.all(handle.closers.map((c) => c.close()));
  });

  it("closers close cleanly, with or without startLoops() having run", async () => {
    const handle = await startPublicSite(await testEnv());
    await expect(Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()))).resolves.not.toThrow();

    const started = await startPublicSite(await testEnv());
    started.startLoops();
    await expect(Promise.all([...started.closeBeforeServer, ...started.closers].map((c) => c.close()))).resolves.not.toThrow();
  });
});
