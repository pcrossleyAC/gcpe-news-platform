import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { hashPassword } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";
import { createDistributionTestDb, sampleMessageRequest } from "../test/helpers";
import { startSmtpSink } from "../test/smtp-sink";
import { createBatch } from "./messages";
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

  // startDistribution builds sendOptions.messageIdDomain/replyTo from parsed.MESSAGE_ID_DOMAIN
  // and parsed.MAIL_REPLY_TO — sender.ts's own tests pass those in directly, so nothing else
  // exercises this wiring. An actual send through the real handle (not a unit test of
  // sender.ts in isolation) is what fails if those two lines were ever dropped.
  it("sends with the Message-ID domain and Reply-To this env resolves to, end to end through the real handle", async () => {
    const sink = await startSmtpSink();
    try {
      const tdb = await createDistributionTestDb();
      dbs.push(tdb);
      const hash = await hashPassword("fixture-password-for-start-tests");
      const handle = await startDistribution({
        DATABASE_URL: tdb.url,
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(sink.port),
        MAIL_FROM: "news@gov.bc.ca",
        MAIL_ALLOW_REAL_RECIPIENTS: "true",
        MESSAGE_ID_DOMAIN: "wiring-test.example",
        MAIL_REPLY_TO: "reply-wiring@example.com",
        LOCAL_ADMIN_ENABLED: "true",
        LOCAL_ADMIN_PASSWORD_HASH: hash,
        LOCAL_AUTH_SECRET: "x".repeat(32),
      });
      try {
        await createBatch(tdb.db, "wiring-test-app", { ...sampleMessageRequest, recipients: [{ email: "x@example.com", substitutions: {} }] }, []);
        await handle.workers.send!();

        expect(sink.messages).toHaveLength(1);
        expect(sink.messages[0]!.messageId).toMatch(/@wiring-test\.example>$/);
        expect(sink.messages[0]!.replyTo?.value[0]?.address).toBe("reply-wiring@example.com");
      } finally {
        await Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()));
      }
    } finally {
      await sink.close();
    }
  });
});
