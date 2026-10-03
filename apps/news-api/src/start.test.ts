import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNewsTestDb, EVENT_SECRETS } from "../test/helpers";
import { startNewsApi } from "./start";

describe("startNewsApi", () => {
  let tdb: TestDatabase;

  afterEach(async () => {
    await tdb?.drop();
  });

  async function testEnv(): Promise<NodeJS.ProcessEnv> {
    tdb = await createNewsTestDb();
    return {
      DATABASE_URL: tdb.url,
      EVENT_SECRETS: JSON.stringify(EVENT_SECRETS),
    };
  }

  it("returns a handle whose app answers health checks", async () => {
    const handle = await startNewsApi(await testEnv());
    expect((await request(handle.app).get("/health/live")).status).toBe(200);
    expect((await request(handle.app).get("/health/ready")).status).toBe(200);
    await Promise.all(handle.closers.map((c) => c.close()));
  });

  it("runs each worker once without throwing on an empty DB", async () => {
    const handle = await startNewsApi(await testEnv());
    for (const run of Object.values(handle.workers)) {
      await run();
    }
    await Promise.all(handle.closers.map((c) => c.close()));
  });

  it("closers close cleanly, with or without startLoops() having run", async () => {
    const handle = await startNewsApi(await testEnv());
    await expect(Promise.all(handle.closers.map((c) => c.close()))).resolves.not.toThrow();

    tdb = await createNewsTestDb();
    const started = await startNewsApi({ DATABASE_URL: tdb.url, EVENT_SECRETS: JSON.stringify(EVENT_SECRETS) });
    started.startLoops();
    await expect(Promise.all(started.closers.map((c) => c.close()))).resolves.not.toThrow();
  });

  it("{ hub: false }: no hub router/attach/LISTEN connection, readiness without the LISTEN check, /updates/negotiate 404s", async () => {
    const handle = await startNewsApi(await testEnv(), { hub: false });
    expect(handle.attach).toBeUndefined();
    expect((await request(handle.app).get("/health/ready")).status).toBe(200);
    const negotiate = await request(handle.app).post("/updates/negotiate");
    expect(negotiate.status).toBe(404);
    await Promise.all(handle.closers.map((c) => c.close()));
  });
});
