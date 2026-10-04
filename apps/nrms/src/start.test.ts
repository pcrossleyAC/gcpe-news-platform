import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { decodeJwt } from "jose";
import { hashPassword, serviceTokenProvider } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNrmsTestDb } from "../test/helpers";
import { nodServiceTokenOptions, startNrms } from "./start";

describe("startNrms", () => {
  // Every DB created by testEnv() this test created, dropped in afterEach — a test
  // reassigning one `let tdb` and dropping only that one leaked every earlier DB it made
  // (P2-R29 fix round 1, item 2).
  const dbs: TestDatabase[] = [];

  afterEach(async () => {
    await Promise.all(dbs.splice(0).map((d) => d.drop()));
  });

  async function testEnv(): Promise<NodeJS.ProcessEnv> {
    const tdb = await createNrmsTestDb();
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
    const handle = await startNrms(await testEnv());
    expect((await request(handle.app).get("/health/live")).status).toBe(200);
    expect((await request(handle.app).get("/health/ready")).status).toBe(200);
    await Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()));
  });

  it("has no closeBeforeServer closers (NRMS has nothing that must close before the http server)", async () => {
    const handle = await startNrms(await testEnv());
    expect(handle.closeBeforeServer).toEqual([]);
    await Promise.all(handle.closers.map((c) => c.close()));
  });

  it("runs each worker once without throwing on an empty DB", async () => {
    const handle = await startNrms(await testEnv());
    for (const run of Object.values(handle.workers)) {
      await run();
    }
    await Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()));
  });

  it("closers close cleanly, with or without startLoops() having run", async () => {
    const handle = await startNrms(await testEnv());
    await expect(Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()))).resolves.not.toThrow();

    const started = await startNrms(await testEnv());
    started.startLoops();
    await expect(Promise.all([...started.closeBeforeServer, ...started.closers].map((c) => c.close()))).resolves.not.toThrow();
  });
});

// Fix round 1 (review finding): NRMS's token for NoD must carry a dedicated, read-only
// "NoD.SubscriberCount" role — not "NRMS.Editor", which on the local-auth branch is a full
// NRMS write credential (same LOCAL_AUTH_SECRET/issuer/audience everywhere) and far more than
// reading a count needs.
describe("nodServiceTokenOptions", () => {
  const local = { username: "admin", passwordHash: "x", secret: "s".repeat(40) };

  it("asks for exactly the NoD.SubscriberCount role, subject nrms", () => {
    const opts = nodServiceTokenOptions({ NOD_TOKEN_URL: undefined, NOD_CLIENT_ID: undefined, NOD_CLIENT_SECRET: undefined, NOD_SCOPE: undefined }, local);
    expect(opts.subject).toBe("nrms");
    expect(opts.roles).toEqual(["NoD.SubscriberCount"]);
    expect(opts.envPrefix).toBe("NOD");
  });

  it("wired through serviceTokenProvider, mints a local token carrying only NoD.SubscriberCount", async () => {
    const opts = nodServiceTokenOptions({ NOD_TOKEN_URL: undefined, NOD_CLIENT_ID: undefined, NOD_CLIENT_SECRET: undefined, NOD_SCOPE: undefined }, local);
    const getToken = serviceTokenProvider(opts);
    const token = await getToken();
    const payload = decodeJwt(token);
    expect(payload).toMatchObject({ sub: "nrms", azp: "nrms", roles: ["NoD.SubscriberCount"] });
  });
});
