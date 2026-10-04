// Stack-level tests (task-14-brief.md's checklist) plus the Phase 2 exit check replayed
// through the stack's single server and /stack/tick instead of six separate processes.
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { hashPassword } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";
import { signPayload } from "@gcpe/events";

import { createCoreTestDb } from "../../core/test/helpers";
import { createNrmsTestDb, sampleDraft } from "../../nrms/test/helpers";
import { createNewsTestDb } from "../../news-api/test/helpers";
import { createPublicSiteTestDb } from "../../public-site/test/helpers";
import { createNodTestDb } from "../../nod/test/helpers";
import { createDistributionTestDb } from "../../distribution/test/helpers";
import { startSmtpSink } from "../../distribution/test/smtp-sink";

import { startStack } from "./stack";

const TICK_TOKEN = "stack-tick-token-at-least-32-characters-long";
const LOCAL_AUTH_SECRET = "stack-test-local-auth-secret-32-characters!";

const SECRET_NRMS_TO_NEWS_API = "stack-e2e-nrms-to-news-api-secret";
const SECRET_NRMS_TO_NOD = "stack-e2e-nrms-to-nod-secret";
const SECRET_NEWS_API_TO_PUBLIC_SITE = "stack-e2e-news-api-to-public-site-secret";
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

describe("apps/stack", () => {
  const dbs: TestDatabase[] = [];
  let outputDir: string | undefined;
  let sink: Awaited<ReturnType<typeof startSmtpSink>> | undefined;
  let bound: Awaited<ReturnType<typeof listenOnPort>> | undefined;
  let handle: Awaited<ReturnType<typeof startStack>> | undefined;
  let stackUrl: string;
  let adminToken: string;

  beforeAll(async () => {
    const dbResults = await Promise.allSettled([
      createCoreTestDb(),
      createNrmsTestDb(),
      createNewsTestDb(),
      createPublicSiteTestDb(),
      createNodTestDb(),
      createDistributionTestDb(),
    ]);
    for (const r of dbResults) if (r.status === "fulfilled") dbs.push(r.value);
    const rejected = dbResults.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (rejected) throw rejected.reason;
    const [coreDb, nrmsDb, newsApiDb, publicSiteDb, nodDb, distributionDb] = dbResults.map(
      (r) => (r as PromiseFulfilledResult<TestDatabase>).value,
    ) as [TestDatabase, TestDatabase, TestDatabase, TestDatabase, TestDatabase, TestDatabase];

    outputDir = await mkdtemp(join(tmpdir(), "gcpe-stack-test-"));
    sink = await startSmtpSink();

    const port = await probeFreePort();
    const passwordHash = await hashPassword("stack-test-password-99");
    const siteUrl = `http://127.0.0.1:${port}/site`;

    const env: NodeJS.ProcessEnv = {
      PORT: String(port),
      TICK_TOKEN,
      STACK_LOOPS: "false",
      UPDATES_HUB_ENABLED: "false",
      NODE_ENV: "test",
      LOCAL_ADMIN_ENABLED: "true",
      LOCAL_ADMIN_PASSWORD_HASH: passwordHash,
      LOCAL_AUTH_SECRET,

      CORE_DATABASE_URL: coreDb.url,

      NRMS_DATABASE_URL: nrmsDb.url,
      NRMS_EVENT_SUBSCRIBERS: JSON.stringify([
        { name: "news-api", url: "self:/events", secret: SECRET_NRMS_TO_NEWS_API, types: ["release.published"] },
        { name: "nod", url: "self:/nod/events", secret: SECRET_NRMS_TO_NOD, types: ["release.published"] },
      ]),

      NEWSAPI_DATABASE_URL: newsApiDb.url,
      NEWSAPI_EVENT_SECRETS: JSON.stringify({ nrms: SECRET_NRMS_TO_NEWS_API }),
      NEWSAPI_EVENT_SUBSCRIBERS: JSON.stringify([
        { name: "public-site", url: "self:/site-builder/events", secret: SECRET_NEWS_API_TO_PUBLIC_SITE, types: ["site.rebuild_requested"] },
      ]),

      SITE_DATABASE_URL: publicSiteDb.url,
      SITE_NEWS_API_URL: `http://127.0.0.1:${port}`,
      SITE_OUTPUT_DIR: outputDir,
      SITE_EVENT_SECRETS: JSON.stringify({ "news-api": SECRET_NEWS_API_TO_PUBLIC_SITE }),
      SITE_PUBLIC_SITE_URL: siteUrl,

      NOD_DATABASE_URL: nodDb.url,
      NOD_EVENT_SECRETS: JSON.stringify({ nrms: SECRET_NRMS_TO_NOD }),
      NOD_DISTRIBUTION_URL: `http://127.0.0.1:${port}/distribution`,
      NOD_PUBLIC_SITE_URL: siteUrl,
      NOD_MANAGE_URL: MANAGE_URL,

      DIST_DATABASE_URL: distributionDb.url,
      DIST_SMTP_HOST: "127.0.0.1",
      DIST_SMTP_PORT: String(sink.port),
      DIST_SMTP_SECURE: "false",
      DIST_MAIL_FROM: "noreply@example.gov.bc.ca",
      DIST_MAIL_ALLOW_REAL_RECIPIENTS: "true",
    };

    handle = await startStack(env);
    expect(handle.port).toBe(port);
    bound = await listenOnPort(handle.app, handle.port);
    stackUrl = `http://127.0.0.1:${handle.port}`;

    const tokenRes = await fetch(`${stackUrl}/nrms/auth/local/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "stack-test-password-99" }),
    });
    expect(tokenRes.status).toBe(200);
    ({ access_token: adminToken } = (await tokenRes.json()) as { access_token: string });
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    const step = async (fn: () => unknown): Promise<void> => {
      try {
        await fn();
      } catch (e) {
        errors.push(e);
      }
    };
    // Same shutdown order main.ts uses: closeBeforeServer -> http server -> closers.
    if (handle) await Promise.all(handle.closeBeforeServer.map((c) => step(() => c.close())));
    await step(() => bound?.close());
    if (handle) await Promise.all(handle.closers.map((c) => step(() => c.close())));
    await step(() => sink?.close());
    for (const db of dbs) await step(() => db.drop());
    await step(() => (outputDir ? rm(outputDir, { recursive: true, force: true }) : undefined));
    if (errors.length > 0) throw errors[0];
  });

  it("every app's health endpoint answers through the stack's single server", async () => {
    for (const path of ["/core/health/live", "/nrms/health/live", "/nod/health/live", "/distribution/health/live", "/site-builder/health/live", "/health/live"]) {
      const res = await fetch(`${stackUrl}${path}`);
      expect.soft(res.status, path).toBe(200);
    }
  });

  it("GET /stack/health aggregates every app's own readiness", async () => {
    const res = await fetch(`${stackUrl}/stack/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; apps: Record<string, boolean> };
    expect(body.status).toBe("ok");
    expect(body.apps).toEqual({ core: true, nrms: true, nod: true, distribution: true, "site-builder": true, "news-api": true });
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
    const res = await fetch(`${stackUrl}/nod/events`, {
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
    await fsStorage(outputDir!).write("probe.html", "<p>hi</p>");
    const res = await fetch(`${stackUrl}/site/probe.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p>hi</p>");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("every other response defaults to Cache-Control: no-store, overriding a weaker header the app set itself", async () => {
    const api = await fetch(`${stackUrl}/api/Home?api-version=1.0`);
    expect(api.status).toBe(200);
    expect(api.headers.get("cache-control")).toBe("no-store");

    const health = await fetch(`${stackUrl}/nrms/health/live`);
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
  });

  describe("/stack/tick", () => {
    it("401s without a token", async () => {
      expect((await fetch(`${stackUrl}/stack/tick`, { method: "POST" })).status).toBe(401);
    });

    it("200s with the right bearer token and runs every app's worker once", async () => {
      const res = await fetch(`${stackUrl}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${TICK_TOKEN}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ran: Record<string, string>; ms: number };
      expect(Object.keys(body.ran)).toEqual(["nrms.publish", "nrms.dispatch", "core.dispatch", "news-api.dispatch", "nod.send", "distribution.send"]);
      expect(Object.values(body.ran)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"]);
      expect(body.ms).toBeGreaterThanOrEqual(0);
    });

    it("coalesces an overlapping tick into 202 {skipped:true}", async () => {
      const [a, b] = await Promise.all([
        fetch(`${stackUrl}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${TICK_TOKEN}` } }),
        fetch(`${stackUrl}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${TICK_TOKEN}` } }),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 202]);
    });
  });

  describe("/stack/errors", () => {
    it("401s with no bearer", async () => {
      expect((await fetch(`${stackUrl}/stack/errors`)).status).toBe(401);
    });

    it("200s with a Core.Admin bearer and returns captured console.error entries", async () => {
      console.error("stack.test.ts probe error for /stack/errors");
      const res = await fetch(`${stackUrl}/stack/errors`, { headers: { authorization: `Bearer ${adminToken}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { errors: { timestamp: string; message: string }[] };
      expect(body.errors.some((e) => e.message.includes("stack.test.ts probe error"))).toBe(true);
    });
  });

  it("Phase 2 exit check: a release created through /nrms/api reaches a static page and an email, driven only by /stack/tick", async () => {
    const draft = { ...sampleDraft, key: "2026HLTH0099-000099" };
    const createRes = await fetch(`${stackUrl}/nrms/api/releases`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(draft),
    });
    expect(createRes.status).toBe(201);

    const publishAt = new Date(Date.now() - 60_000).toISOString();
    const scheduleRes = await fetch(`${stackUrl}/nrms/api/releases/${draft.key}/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ publishAt }),
    });
    expect(scheduleRes.status).toBe(200);

    const subscriberRes = await fetch(`${stackUrl}/nod/api/subscribers`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ email: "alex.example@gov.bc.ca", lists: ["ministries:health"] }),
    });
    expect([201, 409]).toContain(subscriberRes.status); // 409 if a prior test run's subscriber row survived

    async function tick(): Promise<void> {
      const res = await fetch(`${stackUrl}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${TICK_TOKEN}` } });
      expect(res.status).toBe(200);
    }

    await tick();
    let postHtml: string | undefined;
    try {
      postHtml = await readFile(join(outputDir!, "releases", draft.key, "index.html"), "utf8");
    } catch {
      // Brief: "call the tick (twice if needed)".
      await tick();
      postHtml = await readFile(join(outputDir!, "releases", draft.key, "index.html"), "utf8");
    }
    expect(postHtml).toContain(draft.documents[0]!.headline!);

    const pageRes = await fetch(`${stackUrl}/site/releases/${draft.key}/`);
    expect(pageRes.status).toBe(200);

    await expect
      .poll(() => sink!.messages.length, { timeout: 5000 })
      .toBeGreaterThan(0);
    const mail = sink!.messages.find((m) => m.subject === draft.documents[0]!.headline);
    expect(mail).toBeDefined();
    const toAddress = mail!.to && "value" in mail!.to ? mail!.to.value[0]?.address : undefined;
    expect(toAddress).toBe("alex.example@gov.bc.ca");
  });
});
