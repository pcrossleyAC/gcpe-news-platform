import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createPublicSiteTestDb } from "../test/helpers";
import { startPublicSite } from "./start";

describe("startPublicSite", () => {
  let tdb: TestDatabase;

  afterAll(async () => {
    await tdb?.drop();
  });

  async function testEnv(): Promise<NodeJS.ProcessEnv> {
    tdb = await createPublicSiteTestDb();
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
    await Promise.all(handle.closers.map((c) => c.close()));
  });

  it("has no workers (Public Site has no background loops)", async () => {
    const handle = await startPublicSite(await testEnv());
    expect(Object.keys(handle.workers)).toEqual([]);
    await Promise.all(handle.closers.map((c) => c.close()));
  });

  it("closers close cleanly, with or without startLoops() having run", async () => {
    const handle = await startPublicSite(await testEnv());
    await expect(Promise.all(handle.closers.map((c) => c.close()))).resolves.not.toThrow();

    const started = await startPublicSite(await testEnv());
    started.startLoops();
    await expect(Promise.all(started.closers.map((c) => c.close()))).resolves.not.toThrow();
  });
});
