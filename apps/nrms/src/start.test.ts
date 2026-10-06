import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { decodeJwt } from "jose";
import { hashPassword, serviceTokenProvider } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNrmsTestDb } from "../test/helpers";
import { buildBlueBridgeNotify, coreServiceTokenOptions, distributionServiceTokenOptions, flickrConfigFromEnv, nodServiceTokenOptions, nrmsEnvSchema, startNrms } from "./start";
import type { CoreClient, DistributionClient } from "./clients";

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

describe("distributionServiceTokenOptions", () => {
  const local = { username: "admin", passwordHash: "x", secret: "s".repeat(40) };
  const none = { DISTRIBUTION_TOKEN_URL: undefined, DISTRIBUTION_CLIENT_ID: undefined, DISTRIBUTION_CLIENT_SECRET: undefined, DISTRIBUTION_SCOPE: undefined };

  it("asks for exactly the Distribution.Send role, subject nrms (Distribution scopes idempotency by azp)", async () => {
    const opts = distributionServiceTokenOptions(none, local);
    expect(opts).toMatchObject({ subject: "nrms", roles: ["Distribution.Send"], envPrefix: "DISTRIBUTION" });
    const payload = decodeJwt(await serviceTokenProvider(opts)());
    expect(payload).toMatchObject({ sub: "nrms", azp: "nrms", roles: ["Distribution.Send"] });
  });
});

// Plan 3d task 4: mirrors nodServiceTokenOptions exactly — NRMS's token for Core's admin
// directory carries only the dedicated, read-only "Core.AdminDirectory" role, never the full
// "Core.Admin" credential.
describe("coreServiceTokenOptions", () => {
  const local = { username: "admin", passwordHash: "x", secret: "s".repeat(40) };
  const none = { CORE_TOKEN_URL: undefined, CORE_CLIENT_ID: undefined, CORE_CLIENT_SECRET: undefined, CORE_SCOPE: undefined };

  it("asks for exactly the Core.AdminDirectory role, subject nrms", () => {
    const opts = coreServiceTokenOptions(none, local);
    expect(opts.subject).toBe("nrms");
    expect(opts.roles).toEqual(["Core.AdminDirectory"]);
    expect(opts.envPrefix).toBe("CORE");
  });

  it("wired through serviceTokenProvider, mints a local token carrying only Core.AdminDirectory", async () => {
    const opts = coreServiceTokenOptions(none, local);
    const getToken = serviceTokenProvider(opts);
    const token = await getToken();
    const payload = decodeJwt(token);
    expect(payload).toMatchObject({ sub: "nrms", azp: "nrms", roles: ["Core.AdminDirectory"] });
  });
});

// Minor 2 (fix round 1): pulled out of startNrms so the branching can be tested directly.
describe("buildBlueBridgeNotify", () => {
  it("logs the subject only when either client is missing — never sends, never addresses", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await buildBlueBridgeNotify(undefined, undefined)("Project Blue Bridge turned ON on https://news.example", "text with an actor name");
      expect(log).toHaveBeenCalledWith("[nrms] blue bridge: Project Blue Bridge turned ON on https://news.example");
    } finally {
      log.mockRestore();
    }
  });

  it("with both configured, emails every active admin via Distribution", async () => {
    const core: CoreClient = { adminEmails: vi.fn(async () => ["a@example.test", "b@example.test"]) };
    const distribution: DistributionClient = { send: vi.fn(async () => ({ batchId: "b-1" })) };
    const notify = buildBlueBridgeNotify(core, distribution);
    await notify("subject", "text & <escaped>");
    expect(distribution.send).toHaveBeenCalledTimes(1);
    const [msg] = (distribution.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(msg).toMatchObject({ priority: "system", subject: "subject", text: "text & <escaped>", recipients: [{ email: "a@example.test" }, { email: "b@example.test" }] });
    expect(msg.html).not.toContain("<escaped>");
    expect(msg.html).toContain("&#38;"); // "&" escaped — never raw markup from the actor's name/site URL
  });

  // Minor 2: zero active admins must warn, not fail silently.
  it("with both configured but zero active admins, warns and never calls Distribution", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const core: CoreClient = { adminEmails: vi.fn(async () => []) };
      const distribution: DistributionClient = { send: vi.fn(async () => ({ batchId: "b-1" })) };
      await buildBlueBridgeNotify(core, distribution)("subject", "text");
      expect(distribution.send).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("[nrms] blue bridge: no Core.Admin recipients");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("Flickr configuration", () => {
  const base = { DATABASE_URL: "postgres://u:p@localhost/nrms" };
  const creds = {
    FLICKR_API_KEY: "key-1",
    FLICKR_API_SECRET: "secret-1",
    FLICKR_ACCESS_TOKEN: "token-1",
    FLICKR_ACCESS_SECRET: "token-secret-1",
  };

  it("no FLICKR_API_KEY means no Flickr (features report unavailable)", () => {
    const parsed = nrmsEnvSchema.parse(base);
    expect(parsed.FLICKR_MODE).toBe("real");
    expect(parsed.FLICKR_ALERT_EMAILS).toEqual([]);
    expect(flickrConfigFromEnv(parsed)).toBeNull();
    expect(flickrConfigFromEnv(nrmsEnvSchema.parse({ ...base, FLICKR_API_KEY: "" }))).toBeNull();
  });

  it("a key with its secrets gives a config pointing at the real Flickr endpoints by default", () => {
    const parsed = nrmsEnvSchema.parse({ ...base, ...creds, FLICKR_ALERT_EMAILS: " a@gov.bc.ca, b@gov.bc.ca ,," });
    expect(flickrConfigFromEnv(parsed)).toEqual({
      apiKey: "key-1",
      apiSecret: "secret-1",
      accessToken: "token-1",
      accessSecret: "token-secret-1",
      restUrl: "https://api.flickr.com/services/rest",
      oembedUrl: "https://www.flickr.com/services/oembed",
    });
    expect(parsed.FLICKR_OAUTH_URL).toBe("https://www.flickr.com/services/oauth");
    expect(parsed.FLICKR_ALERT_EMAILS).toEqual(["a@gov.bc.ca", "b@gov.bc.ca"]);
  });

  it("the stack's fake mode overrides the endpoints", () => {
    const parsed = nrmsEnvSchema.parse({
      ...base,
      ...creds,
      FLICKR_MODE: "fake",
      FLICKR_REST_URL: "http://stack.internal/fake-flickr/services/rest",
      FLICKR_OEMBED_URL: "http://stack.internal/fake-flickr/services/oembed",
      FLICKR_OAUTH_URL: "http://stack.internal/fake-flickr/services/oauth",
    });
    expect(parsed.FLICKR_MODE).toBe("fake");
    expect(flickrConfigFromEnv(parsed)).toMatchObject({
      restUrl: "http://stack.internal/fake-flickr/services/rest",
      oembedUrl: "http://stack.internal/fake-flickr/services/oembed",
    });
  });

  it("a key without its secrets, a bad mode or a bad alert address fails at startup without echoing secrets", () => {
    const partial = nrmsEnvSchema.safeParse({ ...base, FLICKR_API_KEY: "key-1", FLICKR_API_SECRET: "secret-1" });
    expect(partial.success).toBe(false);
    const text = JSON.stringify(partial.error?.issues);
    expect(text).toMatch(/FLICKR_ACCESS_TOKEN/);
    expect(text).toMatch(/FLICKR_ACCESS_SECRET/);
    expect(text).not.toContain("secret-1");
    expect(nrmsEnvSchema.safeParse({ ...base, FLICKR_MODE: "sandbox" }).success).toBe(false);
    expect(nrmsEnvSchema.safeParse({ ...base, FLICKR_ALERT_EMAILS: "not-an-email" }).success).toBe(false);
  });
});
