// Stack-level tests (task-14-brief.md's checklist, plus fix round 1 / P2-R30) and the Phase 2
// exit check replayed through the stack's single server and /stack/tick instead of six
// separate processes.
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { hashPassword, mintLocalToken } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";

import { createCoreTestDb, healthOrg } from "../../core/test/helpers";
import { createNrmsTestDb, sampleCreate } from "../../nrms/test/helpers";
import { createNewsTestDb } from "../../news-api/test/helpers";
import { createPublicSiteTestDb } from "../../public-site/test/helpers";
import { createNodTestDb } from "../../nod/test/helpers";
import { createDistributionTestDb } from "../../distribution/test/helpers";
import { startSmtpSink } from "../../distribution/test/smtp-sink";

import { startStack } from "./stack";

const LOCAL_AUTH_SECRET = "stack-test-local-auth-secret-32-characters!";
const ADMIN_PASSWORD = "stack-test-password-99";

// Important fix 1 (P2-R30): Core -> News API, over a self: URL, same as NRMS -> News API.
const STACK_EVENT_SECRET = "stack-e2e-event-secret-" + "s".repeat(32);
const MANAGE_URL = "http://nod.invalid/manage";

/** Binds a throwaway server to learn a free port, then closes it — same probe-then-rebind
 * trick stack.ts itself uses for PORT=0, needed here because the cross-app loopback URLs
 * baked into env (NOD_DISTRIBUTION_URL etc.) must be known *before* startStack() is called. */
async function probeFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Binds `app` to the exact `port` determined above (tests/e2e/support.ts's `listen()` always
 * uses an OS-assigned port, which doesn't work here since the stack's own self-referencing
 * URLs were already baked in using a specific, known port number). */
async function listenOnPort(app: Express, port: number): Promise<{ server: Server; close(): Promise<void> }> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    server,
    // Node's global fetch (undici) keeps loopback sockets open for reuse; server.close()
    // alone waits for every open connection to end first and would hang forever waiting on
    // them. closeAllConnections() forces them shut immediately so close() can actually settle.
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

interface StackTestInstanceDbs {
  core: TestDatabase;
  nrms: TestDatabase;
  newsApi: TestDatabase;
  publicSite: TestDatabase;
  nod: TestDatabase;
  distribution: TestDatabase;
}

interface StackTestInstance {
  handle: Awaited<ReturnType<typeof startStack>>;
  stackUrl: string;
  dbs: StackTestInstanceDbs;
  outputDir: string;
  sink: Awaited<ReturnType<typeof startSmtpSink>>;
  tickToken: string;
  /** Present only when `opts.fetchAdminToken` (the default) — omitted for the M7 rate-limit
   * test, which must start from a clean combined-login-limiter budget (see that describe
   * block for why fetching one here would consume a slot of it). */
  adminToken?: string;
  close(): Promise<void>;
}

/**
 * Spins up one full stack instance against six fresh test databases, a real SMTP sink and a
 * real listening server — the shared fixture for every test below. Each test file-level
 * `describe` that needs its *own* isolated instance (M7's combined-login-rate-limit test, M5's
 * startup-error test) calls this again rather than sharing the main one.
 */
async function setupStack(opts: { fetchAdminToken?: boolean } = {}): Promise<StackTestInstance> {
  const fetchAdminToken = opts.fetchAdminToken ?? true;

  const dbResults = await Promise.allSettled([
    createCoreTestDb(),
    createNrmsTestDb(),
    createNewsTestDb(),
    createPublicSiteTestDb(),
    createNodTestDb(),
    createDistributionTestDb(),
  ]);
  const created: TestDatabase[] = [];
  for (const r of dbResults) if (r.status === "fulfilled") created.push(r.value);
  const rejected = dbResults.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (rejected) {
    await Promise.allSettled(created.map((d) => d.drop()));
    throw rejected.reason;
  }
  const [core, nrms, newsApi, publicSite, nod, distribution] = created as [TestDatabase, TestDatabase, TestDatabase, TestDatabase, TestDatabase, TestDatabase];
  const dbs: StackTestInstanceDbs = { core, nrms, newsApi, publicSite, nod, distribution };

  const outputDir = await mkdtemp(join(tmpdir(), "gcpe-stack-test-"));
  const sink = await startSmtpSink();

  const port = await probeFreePort();
  const passwordHash = await hashPassword(ADMIN_PASSWORD);
  const tickToken = `tick-token-${port}-${"x".repeat(32)}`;

  const env: NodeJS.ProcessEnv = {
    PORT: String(port),
    TICK_TOKEN: tickToken,
    STACK_LOOPS: "false",
    UPDATES_HUB_ENABLED: "false",
    NODE_ENV: "test",
    LOCAL_ADMIN_ENABLED: "true",
    LOCAL_ADMIN_PASSWORD_HASH: passwordHash,
    LOCAL_AUTH_SECRET,
    // P2-R35: all internal event wiring (Core/NRMS -> News API, NRMS -> NoD, News API -> site
    // builder) is derived by the stack from this one secret — no per-app EVENT_* JSON at all.
    STACK_EVENT_SECRET,

    CORE_DATABASE_URL: core.url,

    NRMS_DATABASE_URL: nrms.url,

    NEWSAPI_DATABASE_URL: newsApi.url,

    SITE_DATABASE_URL: publicSite.url,
    // M9: a bare "self:/" (not a hand-built http://127.0.0.1:<port> string) proves the
    // general *_URL resolution, not just EVENT_SUBSCRIBERS.
    SITE_NEWS_API_URL: "self:/",
    SITE_OUTPUT_DIR: outputDir,
    SITE_PUBLIC_SITE_URL: "self:/site",

    NOD_DATABASE_URL: nod.url,
    // M9: NoD -> Distribution, also over a self: URL.
    NOD_DISTRIBUTION_URL: "self:/distribution",
    NOD_PUBLIC_SITE_URL: "self:/site",
    NOD_MANAGE_URL: MANAGE_URL, // external (fake) — never resolved as self:

    DIST_DATABASE_URL: distribution.url,
    DIST_SMTP_HOST: "127.0.0.1",
    DIST_SMTP_PORT: String(sink.port),
    DIST_SMTP_SECURE: "false",
    DIST_MAIL_FROM: "noreply@example.gov.bc.ca",
    DIST_MAIL_ALLOW_REAL_RECIPIENTS: "true",
  };

  const handle = await startStack(env);
  if (handle.port !== port) throw new Error(`expected startStack to keep the requested port ${port}, got ${handle.port}`);
  const bound = await listenOnPort(handle.app, handle.port);
  const stackUrl = `http://127.0.0.1:${handle.port}`;

  let adminToken: string | undefined;
  if (fetchAdminToken) {
    const tokenRes = await fetch(`${stackUrl}/nrms/auth/local/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD }),
    });
    if (tokenRes.status !== 200) throw new Error(`admin token fetch failed: ${tokenRes.status}`);
    ({ access_token: adminToken } = (await tokenRes.json()) as { access_token: string });
  }

  return {
    handle,
    stackUrl,
    dbs,
    outputDir,
    sink,
    tickToken,
    adminToken,
    async close() {
      const errors: unknown[] = [];
      const step = async (fn: () => unknown): Promise<void> => {
        try {
          await fn();
        } catch (e) {
          errors.push(e);
        }
      };
      // Same shutdown order main.ts uses: closeBeforeServer -> http server -> closers.
      await Promise.all(handle.closeBeforeServer.map((c) => step(() => c.close())));
      await step(() => bound.close());
      await Promise.all(handle.closers.map((c) => step(() => c.close())));
      await step(() => sink.close());
      for (const db of Object.values(dbs)) await step(() => db.drop());
      await step(() => rm(outputDir, { recursive: true, force: true }));
      if (errors.length > 0) throw errors[0];
    },
  };
}

describe("apps/stack", () => {
  let instance: StackTestInstance;

  beforeAll(async () => {
    instance = await setupStack();
  });

  afterAll(async () => {
    await instance.close();
  });

  it("every app's health endpoint answers through the stack's single server", async () => {
    for (const path of ["/core/health/live", "/nrms/health/live", "/nod/health/live", "/distribution/health/live", "/site-builder/health/live", "/health/live"]) {
      const res = await fetch(`${instance.stackUrl}${path}`);
      expect.soft(res.status, path).toBe(200);
    }
  });

  it("GET /stack/health aggregates every app's own readiness", async () => {
    const res = await fetch(`${instance.stackUrl}/stack/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; apps: Record<string, boolean> };
    expect(body.status).toBe("ok");
    expect(body.apps).toEqual({ core: true, nrms: true, nod: true, distribution: true, "site-builder": true, "news-api": true });
  });

  // Fix round 1, P2-R30 M8.
  it("GET /stack/health caches the aggregate for ~5s instead of re-fanning-out to every app on each call", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      calls++;
      return originalFetch(...args);
    }) as typeof fetch;
    try {
      await fetch(`${instance.stackUrl}/stack/health`); // may be a cache hit or miss; don't care which
      calls = 0; // only the next call (the one actually asserted on) is counted from here
      const res = await fetch(`${instance.stackUrl}/stack/health`);
      expect(res.status).toBe(200);
      // Exactly our own one outer call — if the cache were absent, this would also count 6
      // more (one loopback fetch per mounted app's /health/ready), i.e. 7.
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Deviation from the brief's literal "/nrms/events ... (receiver mounted)": nrms/src/app.ts
  // has no event receiver at all (nrms only *publishes* release.published; it never
  // receives anything) — verified by reading the code, per implementer-rules.md's "trust the
  // code over the plan's snippets". NoD's app.ts does mount a receiver, so this exercises the
  // same thing (a receiver surviving its stack mount prefix) against the app that actually
  // has one. See task-14-report.md for this deviation.
  it("/nod/events with a bad signature is 401 (receiver mounted and reachable under its prefix)", async () => {
    const event = {
      id: "00000000-0000-0000-0000-000000000001",
      type: "release.published",
      version: 1,
      source: "nrms",
      aggregateId: "release",
      sequence: 1,
      occurredAt: new Date().toISOString(),
      correlationId: "00000000-0000-0000-0000-000000000002",
      data: {},
    };
    const body = JSON.stringify(event);
    const res = await fetch(`${instance.stackUrl}/nod/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-event-source": "nrms",
        "x-event-timestamp": new Date().toISOString(),
        "x-signature": "0".repeat(64), // well-formed hex, but wrong
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  it("/site/ serves a file written into OUTPUT_DIR with Cache-Control: public, max-age=60", async () => {
    const { fsStorage } = await import("../../public-site/src/storage");
    await fsStorage(instance.outputDir).write("probe.html", "<p>hi</p>");
    const res = await fetch(`${instance.stackUrl}/site/probe.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p>hi</p>");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });

  // Fix round 1, P2-R30 M4: express.static's own directory redirect (no trailing slash) must
  // not be cacheable by the SiteGround proxy either.
  it("/site/<dir without trailing slash> redirects 301 with Cache-Control: no-store", async () => {
    const { fsStorage } = await import("../../public-site/src/storage");
    await fsStorage(instance.outputDir).write("probe-dir/index.html", "<p>dir</p>");
    const res = await fetch(`${instance.stackUrl}/site/probe-dir`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("every other response defaults to Cache-Control: no-store, overriding a weaker header the app set itself", async () => {
    const api = await fetch(`${instance.stackUrl}/api/Home?api-version=1.0`);
    expect(api.status).toBe(200);
    expect(api.headers.get("cache-control")).toBe("no-store");

    const health = await fetch(`${instance.stackUrl}/nrms/health/live`);
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
  });

  describe("/stack/tick", () => {
    it("401s without a token", async () => {
      expect((await fetch(`${instance.stackUrl}/stack/tick`, { method: "POST" })).status).toBe(401);
    });

    it("200s with the right bearer token and runs every app's worker once", async () => {
      const res = await fetch(`${instance.stackUrl}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${instance.tickToken}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ran: Record<string, string>; ms: number };
      expect(Object.keys(body.ran)).toEqual(["nrms.publish", "nrms.dispatch", "core.dispatch", "news-api.dispatch", "nod.send", "distribution.send"]);
      expect(Object.values(body.ran)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"]);
      expect(body.ms).toBeGreaterThanOrEqual(0);
    });

    it("coalesces an overlapping tick into 202 {skipped:true}", async () => {
      const [a, b] = await Promise.all([
        fetch(`${instance.stackUrl}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${instance.tickToken}` } }),
        fetch(`${instance.stackUrl}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${instance.tickToken}` } }),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 202]);
    });
  });

  describe("/stack/errors", () => {
    it("401s with no bearer", async () => {
      expect((await fetch(`${instance.stackUrl}/stack/errors`)).status).toBe(401);
    });

    it("200s with a Core.Admin bearer and returns captured console.error entries", async () => {
      console.error("stack.test.ts probe error for /stack/errors");
      const res = await fetch(`${instance.stackUrl}/stack/errors`, { headers: { authorization: `Bearer ${instance.adminToken}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { errors: { timestamp: string; message: string }[] };
      expect(body.errors.some((e) => e.message.includes("stack.test.ts probe error"))).toBe(true);
    });

    // Important fix 2, P2-R30: a valid bearer that just doesn't carry Core.Admin must be 403
    // (requireRole), not treated as unauthenticated (401) or, worse, let through.
    it("403s a valid bearer that doesn't carry Core.Admin", async () => {
      const nonAdminToken = await mintLocalToken({ secret: LOCAL_AUTH_SECRET, subject: "editor", roles: ["NRMS.Editor"] });
      const res = await fetch(`${instance.stackUrl}/stack/errors`, { headers: { authorization: `Bearer ${nonAdminToken}` } });
      expect(res.status).toBe(403);
    });
  });

  // Important fix 1, P2-R30: Core's own EVENT_SUBSCRIBERS (self:/events) must actually reach
  // News API, exactly like NRMS's does — before the fix, Core's self: URL was never resolved,
  // so this delivery would fail (an "unknown scheme" fetch error, recorded as a retry/dead
  // delivery in Core's own outbox) and News API's inbox would never see it.
  it("Core's org.upserted reaches News API over its own self: EVENT_SUBSCRIBERS url, driven by /stack/tick", async () => {
    const putRes = await fetch(`${instance.stackUrl}/core/api/organizations/${healthOrg.key}`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${instance.adminToken}` },
      body: JSON.stringify(healthOrg),
    });
    expect(putRes.status).toBe(200);

    const tickRes = await fetch(`${instance.stackUrl}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${instance.tickToken}` } });
    expect(tickRes.status).toBe(200);
    const tickBody = (await tickRes.json()) as { ran: Record<string, string> };
    expect(tickBody.ran["core.dispatch"]).toBe("ok");

    const inbox = await instance.dbs.newsApi.pool.query<{ source: string; type: string; outcome: string }>(
      "SELECT source, type, outcome FROM inbox_events WHERE source = 'core' AND type = 'org.upserted'",
    );
    expect(inbox.rows).toEqual([{ source: "core", type: "org.upserted", outcome: "applied" }]);
  });

  it("a ministry saved in Core shows up in NRMS's categories after a tick", async () => {
    const putRes = await fetch(`${instance.stackUrl}/core/api/organizations/${healthOrg.key}`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${instance.adminToken}` },
      body: JSON.stringify(healthOrg),
    });
    expect(putRes.status).toBe(200);

    const tickRes = await fetch(`${instance.stackUrl}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${instance.tickToken}` } });
    expect(tickRes.status).toBe(200);

    const res = await fetch(`${instance.stackUrl}/nrms/api/categories`, { headers: { authorization: `Bearer ${instance.adminToken}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ministries: { key: string; name: string; abbreviation: string | null }[] };
    expect(body.ministries).toContainEqual({ key: "health", name: "Health", abbreviation: "HLTH" });
  });

  it("Phase 2 exit check: a release created through /nrms/api reaches a static page and an email, driven only by /stack/tick", async () => {
    const admin = { "content-type": "application/json", authorization: `Bearer ${instance.adminToken}` };
    // NRMS validates ministries and sectors against its copy of Core's taxonomy and takes the
    // Key's abbreviation from the lead ministry: save both in Core and tick once to deliver them.
    const orgRes = await fetch(`${instance.stackUrl}/core/api/organizations/${healthOrg.key}`, { method: "PUT", headers: admin, body: JSON.stringify(healthOrg) });
    expect(orgRes.status).toBe(200);
    const sector = { kind: "sector", key: "health", displayName: "Health", sortOrder: 0, isActive: true, social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null } };
    const sectorRes = await fetch(`${instance.stackUrl}/core/api/terms/sector/health`, { method: "PUT", headers: admin, body: JSON.stringify(sector) });
    expect(sectorRes.status).toBe(200);
    const taxonomyTick = await fetch(`${instance.stackUrl}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${instance.tickToken}` } });
    expect(taxonomyTick.status).toBe(200);

    const nrmsPost = async (path: string, body: unknown) => {
      const res = await fetch(`${instance.stackUrl}/nrms/api/releases${path}`, { method: "POST", headers: admin, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as { id: string; key: string | null; version: number; status: string } };
    };
    const created = await nrmsPost("", sampleCreate);
    expect(created.status).toBe(201);
    const approved = await nrmsPost(`/${created.body.id}/approve`, { version: created.body.version });
    expect(approved.status).toBe(200);
    const key = approved.body.key!;
    const scheduled = await nrmsPost(`/${created.body.id}/schedule`, { version: approved.body.version, publishAt: "now" });
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.status).toBe("scheduled");
    const headline = sampleCreate.headline;

    const subscriberRes = await fetch(`${instance.stackUrl}/nod/api/subscribers`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${instance.adminToken}` },
      body: JSON.stringify({ email: "alex.example@gov.bc.ca", lists: ["ministries:health"] }),
    });
    expect([201, 409]).toContain(subscriberRes.status); // 409 if a prior test run's subscriber row survived

    async function tick(): Promise<void> {
      const res = await fetch(`${instance.stackUrl}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${instance.tickToken}` } });
      expect(res.status).toBe(200);
    }

    await tick();
    let postHtml: string | undefined;
    try {
      postHtml = await readFile(join(instance.outputDir, "releases", key, "index.html"), "utf8");
    } catch {
      // Brief: "call the tick (twice if needed)".
      await tick();
      postHtml = await readFile(join(instance.outputDir, "releases", key, "index.html"), "utf8");
    }
    expect(postHtml).toContain(headline);

    const pageRes = await fetch(`${instance.stackUrl}/site/releases/${key}/`);
    expect(pageRes.status).toBe(200);

    await expect.poll(() => instance.sink.messages.length, { timeout: 5000 }).toBeGreaterThan(0);
    const mail = instance.sink.messages.find((m) => m.subject === headline);
    expect(mail).toBeDefined();
    const toAddress = mail!.to && "value" in mail!.to ? mail!.to.value[0]?.address : undefined;
    expect(toAddress).toBe("alex.example@gov.bc.ca");
  });
});

// Fix round 1, P2-R30 M5: a standalone instance (not the shared one above) so a deliberately
// broken env (a missing NRMS_DATABASE_URL) can be exercised without disturbing the other
// tests' happy-path fixture.
describe("apps/stack: startup errors name the app and its env prefix (M5)", () => {
  let coreDb: TestDatabase | undefined;

  afterAll(async () => {
    await coreDb?.drop();
  });

  it("a missing NRMS_DATABASE_URL fails startStack with a message naming NRMS and NRMS_*", async () => {
    coreDb = await createCoreTestDb();
    const passwordHash = await hashPassword(ADMIN_PASSWORD);
    const env: NodeJS.ProcessEnv = {
      PORT: "0",
      TICK_TOKEN: "t".repeat(32),
      STACK_LOOPS: "false",
      LOCAL_ADMIN_ENABLED: "true",
      LOCAL_ADMIN_PASSWORD_HASH: passwordHash,
      LOCAL_AUTH_SECRET,
      CORE_DATABASE_URL: coreDb.url,
      // NRMS_DATABASE_URL deliberately omitted.
    };
    await expect(startStack(env)).rejects.toThrow(/^\[stack\] NRMS failed to start \(its variables are NRMS_\*\): /);
  });
});

// Fix round 1, P2-R30 M7: its own isolated stack instance, with no admin-token fetch during
// setup (fetchAdminToken: false) — that fetch is itself a POST to /nrms/auth/local/token,
// which would otherwise consume one slot of the exact budget this test counts against,
// making "the 11th request is 429" false (it would actually be the 10th).
describe("apps/stack: combined login-attempt rate limit across every app (M7)", () => {
  let instance: StackTestInstance;

  beforeAll(async () => {
    instance = await setupStack({ fetchAdminToken: false });
  });

  afterAll(async () => {
    await instance.close();
  });

  it("10/min/IP combined across /core, /nrms, /nod and /distribution's login routes — the 11th is 429", async () => {
    const headers = { "content-type": "application/json" };
    const body = JSON.stringify({ username: "nope", password: "nope" });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await fetch(`${instance.stackUrl}/core/auth/local/token`, { method: "POST", headers, body })).status);
    }
    for (let i = 0; i < 5; i++) {
      statuses.push((await fetch(`${instance.stackUrl}/nrms/auth/local/token`, { method: "POST", headers, body })).status);
    }
    expect(statuses).toHaveLength(11);
    // The first 10 are the apps' own (unauthenticated-credentials) answers, never 429 — the
    // combined limiter hasn't tripped yet.
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

// Mirrors the M7 combined-login-limiter test above, but entirely against /core/auth/login
// (staff sign-in) instead of spreading across the local-admin token routes — same combined
// stack-wide budget (apps/stack/src/stack.ts's combinedLoginLimiter), confirmed to cover this
// route too. Its own isolated instance, with no admin-token fetch during setup
// (fetchAdminToken: false), for the same reason as M7: that fetch would otherwise consume one
// slot of the exact budget this test counts against.
describe("apps/stack: combined login-attempt rate limit covers /core/auth/login", () => {
  let instance: StackTestInstance;

  beforeAll(async () => {
    instance = await setupStack({ fetchAdminToken: false });
  });

  afterAll(async () => {
    await instance.close();
  });

  it("10/min/IP wrong-password POSTs to /core/auth/login - the 11th is 429", async () => {
    const headers = { "content-type": "application/json", "x-gcpe-request": "1" };
    const body = JSON.stringify({ username: "nope", password: "wrong password" });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await fetch(`${instance.stackUrl}/core/auth/login`, { method: "POST", headers, body })).status);
    }
    expect(statuses).toHaveLength(11);
    // The first 10 are Core's own (invalid-credentials) answers, never 429 - the combined
    // limiter hasn't tripped yet.
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("staff session cookie across the stack", () => {
  let inst: StackTestInstance;
  beforeAll(async () => {
    inst = await setupStack({ fetchAdminToken: false });
  });
  afterAll(async () => {
    await inst.close();
  });

  it("a cookie from /core/auth/login authenticates /nrms/api, with the CSRF rule", async () => {
    const login = await fetch(`${inst.stackUrl}/core/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gcpe-request": "1" },
      body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith("gcpe_session="))!.split(";")[0]!;
    expect((await fetch(`${inst.stackUrl}/nrms/api/releases/NO-SUCH-RELEASE`)).status).toBe(401);
    expect((await fetch(`${inst.stackUrl}/nrms/api/releases/NO-SUCH-RELEASE`, { headers: { cookie } })).status).toBe(404);
    const noCsrf = await fetch(`${inst.stackUrl}/nrms/api/releases`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
    expect(noCsrf.status).toBe(403);
    const withCsrf = await fetch(`${inst.stackUrl}/nrms/api/releases`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-gcpe-request": "1" },
      body: "{}",
    });
    expect(withCsrf.status).toBe(400);
  });
});
