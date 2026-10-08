import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { hashPassword, mintLocalToken } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../test/helpers";
import { startNod } from "./start";

const LOCAL_AUTH_SECRET = "x".repeat(32);

describe("startNod", () => {
  // Every DB created by testEnv() this test created, dropped in afterEach — a test
  // reassigning one `let tdb` and dropping only that one leaked every earlier DB it made
  // (P2-R29 fix round 1, item 2).
  const dbs: TestDatabase[] = [];

  afterEach(async () => {
    await Promise.all(dbs.splice(0).map((d) => d.drop()));
  });

  async function testEnv(): Promise<NodeJS.ProcessEnv> {
    const tdb = await createNodTestDb();
    dbs.push(tdb);
    const hash = await hashPassword("fixture-password-for-start-tests");
    return {
      DATABASE_URL: tdb.url,
      // Closed port: a worker iteration on an empty DB claims nothing and never calls out,
      // but the schema still requires valid URLs.
      DISTRIBUTION_URL: "http://127.0.0.1:1",
      PUBLIC_SITE_URL: "http://127.0.0.1:1",
      LINK_SECRET: "x".repeat(32),
      LOCAL_ADMIN_ENABLED: "true",
      LOCAL_ADMIN_PASSWORD_HASH: hash,
      LOCAL_AUTH_SECRET: LOCAL_AUTH_SECRET,
    };
  }

  it("returns a handle whose app answers health checks", async () => {
    const handle = await startNod(await testEnv());
    expect((await request(handle.app).get("/health/live")).status).toBe(200);
    expect((await request(handle.app).get("/health/ready")).status).toBe(200);
    await Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()));
  });

  it("has no closeBeforeServer closers (NoD has nothing that must close before the http server)", async () => {
    const handle = await startNod(await testEnv());
    expect(handle.closeBeforeServer).toEqual([]);
    await Promise.all(handle.closers.map((c) => c.close()));
  });

  it("runs each worker once without throwing on an empty DB", async () => {
    const handle = await startNod(await testEnv());
    expect(Object.keys(handle.workers)).toEqual(expect.arrayContaining(["send", "digest", "mediaSync", "bounceSummary", "purge", "emergencyFeed"]));
    for (const run of Object.values(handle.workers)) {
      await run();
    }
    await Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()));
  });

  it("closers close cleanly, with or without startLoops() having run", async () => {
    const handle = await startNod(await testEnv());
    await expect(Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()))).resolves.not.toThrow();

    const started = await startNod(await testEnv());
    started.startLoops();
    await expect(Promise.all([...started.closeBeforeServer, ...started.closers].map((c) => c.close()))).resolves.not.toThrow();
  });

  // NOD_REPLY_TO is now per type of news (reply-to.ts): system and ops mail carry none even
  // when it is set, so a reply reaches the From mailbox as legacy's "only noreply" did.
  it("an ops email carries no Reply-To even with REPLY_TO set", async () => {
    let capturedBody: { replyTo?: string } | undefined;
    const fakeDistribution: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c));
      req.on("end", () => {
        capturedBody = raw ? (JSON.parse(raw) as { replyTo?: string }) : undefined;
        res.statusCode = 202;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ batchId: "wiring-test" }));
      });
    });
    await new Promise<void>((resolve) => fakeDistribution.listen(0, resolve));
    try {
      const env = await testEnv();
      env.DISTRIBUTION_URL = `http://127.0.0.1:${(fakeDistribution.address() as AddressInfo).port}`;
      env.OPS_EMAIL = "ops@example.com";
      env.REPLY_TO = "reply-wiring@example.com";

      const handle = await startNod(env);
      try {
        const token = await mintLocalToken({ secret: LOCAL_AUTH_SECRET, subject: "wiring-test-admin", roles: ["NoD.Admin"] });
        const res = await request(handle.app).post("/api/settings/pause").set("authorization", `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(capturedBody?.replyTo).toBeUndefined();
      } finally {
        await Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()));
      }
    } finally {
      await new Promise<void>((resolve) => fakeDistribution.close(() => resolve()));
    }
  });
});
