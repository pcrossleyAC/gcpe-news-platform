// Production configuration T7 (owner approved 2026-10-31): the whole stack, started the way the
// real production site is configured — NODE_ENV=production, no SITE_ENVIRONMENT, Microsoft sign-in
// for staff, and the break-glass admin OFF (no LOCAL_ADMIN_* at all) — against real databases.
// Before T2 this configuration could not start: every app's token for calling another app was
// signed with the break-glass secret, and with it off NRMS threw at startup. This proves it
// starts, is not a test site, and that the apps' calls to each other work.
//
// Staff requests here carry the stack's internal token, minted by the test with the derived key
// and sent over the stack's in-memory connection (the test runs in the stack's process): a
// stand-in for a signed-in person, since Microsoft sign-in can't run in CI. The same token over
// the real port is refused, which is asserted too.
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import { mintInternalToken } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";

import { createCoreTestDb, healthOrg } from "../../core/test/helpers";
import { createUser, createUserSchema } from "../../core/src/services/users";
import { createNrmsTestDb, sampleCreate } from "../../nrms/test/helpers";
import { createNewsTestDb } from "../../news-api/test/helpers";
import { createPublicSiteTestDb } from "../../public-site/test/helpers";
import { createNodTestDb } from "../../nod/test/helpers";
import { createDistributionTestDb } from "../../distribution/test/helpers";
import { createCalendarTestDb } from "../../calendar/test/helpers";
import { startSmtpSink } from "../../distribution/test/smtp-sink";

import { serviceTokenSecretFrom } from "./env";
import { INTERNAL_ORIGIN } from "./internal-fetch";
import { startStack } from "./stack";

const STACK_EVENT_SECRET = "prod-shape-event-secret-" + "p".repeat(32);
const AUDIENCE = "api://22222222-2222-4222-8222-222222222222";
const ADMIN_EMAIL = "prod-admin@example.test";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function listen(app: Express, port: number): Promise<{ server: Server; close(): Promise<void> }> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe("apps/stack: a production-shaped stack with the break-glass admin off", { timeout: 60_000 }, () => {
  let dbs: TestDatabase[] = [];
  let core: TestDatabase, nrms: TestDatabase, publicSite: TestDatabase;
  let handle: Awaited<ReturnType<typeof startStack>>;
  let bound: Awaited<ReturnType<typeof listen>>;
  let sink: Awaited<ReturnType<typeof startSmtpSink>>;
  let stackUrl: string;
  let tickToken: string;
  let dirs: string[] = [];
  const warnings: string[] = [];

  /** A staff request over the stack's in-memory connection, carrying the internal token. */
  const staff = async (path: string, roles: string[], init: RequestInit = {}) => {
    const token = await mintInternalToken({ secret: serviceTokenSecretFrom(STACK_EVENT_SECRET), subject: "prod-shape-test", roles });
    return fetch(`${INTERNAL_ORIGIN}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } });
  };
  const tick = async () => {
    const res = await fetch(`${stackUrl}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${tickToken}` } });
    expect(res.status).toBe(200);
    return (await res.json()) as { ran: Record<string, string> };
  };

  beforeAll(async () => {
    const results = await Promise.allSettled([createCoreTestDb(), createNrmsTestDb(), createNewsTestDb(), createPublicSiteTestDb(), createNodTestDb(), createDistributionTestDb(), createCalendarTestDb()]);
    dbs = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
    const [c, n, newsApi, site, nod, dist, calendar] = dbs as [TestDatabase, TestDatabase, TestDatabase, TestDatabase, TestDatabase, TestDatabase, TestDatabase];
    core = c;
    nrms = n;
    publicSite = site;
    // The one person who can administer the live site: a Core.Admin with a government email.
    await createUser(core.db, createUserSchema.parse({ email: ADMIN_EMAIL, displayName: "Prod Admin", roles: ["Core.Admin"], password: "a sample password 1" }), []);

    const outputDir = await mkdtemp(join(tmpdir(), "gcpe-prod-shape-out-"));
    const dataDir = await mkdtemp(join(tmpdir(), "gcpe-prod-shape-data-"));
    dirs = [outputDir, dataDir];
    sink = await startSmtpSink();
    const port = await freePort();
    tickToken = `tick-${port}-${"t".repeat(32)}`;

    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      PORT: String(port),
      TICK_TOKEN: tickToken,
      STACK_LOOPS: "false",
      UPDATES_HUB_ENABLED: "false",
      DATA_DIR: dataDir,
      STACK_EVENT_SECRET,
      // Microsoft sign-in for staff, and every app's audience, as the Windows generator writes them.
      ENTRA_TENANT_ID: "11111111-1111-4111-8111-111111111111",
      CORE_ENTRA_CLIENT_ID: "22222222-2222-4222-8222-222222222222",
      CORE_ENTRA_CLIENT_SECRET: "prod-shape-client-secret",
      CORE_PUBLIC_BASE_URL: "https://news.example.invalid",
      ...Object.fromEntries(["CORE", "NRMS", "NEWSAPI", "SITE", "NOD", "DIST", "CALENDAR"].map((p) => [`${p}_AUTH_AUDIENCE`, AUDIENCE])),
      CORE_DATABASE_URL: core.url,
      NRMS_DATABASE_URL: nrms.url,
      NEWSAPI_DATABASE_URL: newsApi.url,
      SITE_DATABASE_URL: site.url,
      SITE_NEWS_API_URL: "self:/",
      SITE_OUTPUT_DIR: outputDir,
      SITE_PUBLIC_SITE_URL: "https://news.example.invalid",
      NOD_DATABASE_URL: nod.url,
      NOD_DISTRIBUTION_URL: "self:/distribution",
      NOD_PUBLIC_SITE_URL: "https://news.example.invalid",
      // Option C: switched off on purpose, so the stack starts with a warning.
      NOD_EMERGENCY_FEED: "off",
      DIST_DATABASE_URL: dist.url,
      DIST_SMTP_HOST: "127.0.0.1",
      DIST_SMTP_PORT: String(sink.port),
      DIST_SMTP_SECURE: "false",
      DIST_MAIL_FROM: "noreply@example.gov.bc.ca",
      DIST_MAIL_ALLOW_REAL_RECIPIENTS: "true",
      // DIST_BOUNCE_SOURCE left unset: manual upload, started with a warning.
      CALENDAR_DATABASE_URL: calendar.url,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warnings.push(args.map(String).join(" ")));
    try {
      handle = await startStack(env);
    } finally {
      warn.mockRestore();
    }
    bound = await listen(handle.app, handle.port);
    stackUrl = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    const steps: (() => unknown)[] = [];
    if (handle) steps.push(() => Promise.all(handle.closeBeforeServer.map((c) => c.close())));
    if (bound) steps.push(() => bound.close());
    if (handle) steps.push(() => Promise.all(handle.closers.map((c) => c.close())));
    if (sink) steps.push(() => sink.close());
    for (const d of dbs) steps.push(() => d.drop());
    for (const d of dirs) steps.push(() => rm(d, { recursive: true, force: true }));
    for (const s of steps) await Promise.resolve().then(s).catch(() => {});
  });

  it("starts healthy, says out loud what is switched off, and no app has a break-glass login", async () => {
    const health = await fetch(`${stackUrl}/stack/health`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { apps: Record<string, boolean> }).apps).toEqual({ core: true, nrms: true, nod: true, distribution: true, "site-builder": true, "news-api": true, calendar: true });
    expect(warnings.filter((w) => w.includes("PRODUCTION WARNING"))).toEqual([
      expect.stringContaining("Emergency alerts are switched off"),
      expect.stringContaining("Bounces aren't being read"),
    ]);
    expect(warnings.join("\n")).not.toContain("LOCAL ADMIN LOGIN ENABLED");
    for (const app of ["core", "nrms", "nod", "distribution"]) {
      const res = await fetch(`${stackUrl}/${app}/auth/local/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "x" }) });
      expect(res.status, app).toBe(404);
    }
  });

  it("is not a test site: NRMS and NoD both say so, and none of the fakes is mounted", async () => {
    const config = await staff("/nrms/api/config", ["NRMS.Editor"]);
    expect(config.status).toBe(200);
    expect(((await config.json()) as { isTestSite: boolean }).isTestSite).toBe(false);
    for (const fake of ["/fake-emergency-feed/feed.xml", "/fake-media-hub/__fake/contacts", "/fake-flickr/services/rest"]) {
      expect((await fetch(`${stackUrl}${fake}`)).status, fake).toBe(404);
    }
  });

  it("the internal token is refused over the real port, even though it is validly signed", async () => {
    const token = await mintInternalToken({ secret: serviceTokenSecretFrom(STACK_EVENT_SECRET), subject: "outsider", roles: ["NoD.Admin"] });
    expect((await fetch(`${stackUrl}/nod/api/operations`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it("NoD reaches Distribution (pause state and bounce source), and Operations warns as the owner asked", async () => {
    const res = await staff("/nod/api/operations", ["NoD.Admin"]);
    expect(res.status).toBe(200);
    const ops = (await res.json()) as { distribution: { paused: boolean } | null; bounceSource: string | null; testSite: boolean; emergencyFeed: { url: string | null; switchedOff: boolean } };
    expect(ops.distribution).toEqual({ paused: false });
    expect(ops.bounceSource).toBe("fake");
    expect(ops.testSite).toBe(false);
    expect(ops.emergencyFeed).toMatchObject({ url: null, switchedOff: true });
  });

  it("the site builder reads the News API's change feed, and the public Subscribe API reaches NoD", async () => {
    const { ran } = await tick();
    expect(Object.values(ran).every((v) => v === "ok"), JSON.stringify(ran)).toBe(true);
    const { rows } = await publicSite.pool.query("SELECT change_cursor FROM site_state WHERE id = 1");
    expect(rows[0]?.change_cursor).not.toBeNull();
    const items = await fetch(`${stackUrl}/api/Subscribe/SubscriptionItems/ministries?api-version=1.0`);
    expect(items.status).toBe(200);
  });

  it("NRMS reaches NoD (audience counts), the News API (similar releases), Core (admins) and Distribution (the admins' email)", async () => {
    const editor = ["NRMS.Editor", "Core.Admin"];
    // NRMS checks a release's ministry and sector against its copy of Core's: save both, tick once.
    expect((await staff(`/core/api/organizations/${healthOrg.key}`, ["Core.Admin"], { method: "PUT", body: JSON.stringify(healthOrg) })).status).toBe(200);
    const sector = { kind: "sector", key: "health", displayName: "Health", sortOrder: 0, isActive: true, social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null } };
    expect((await staff("/core/api/terms/sector/health", ["Core.Admin"], { method: "PUT", body: JSON.stringify(sector) })).status).toBe(200);
    await tick();
    const created = await staff("/nrms/api/releases", editor, { method: "POST", body: JSON.stringify(sampleCreate) });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    // NRMS -> NoD: a number, not null (null is what NRMS shows when NoD can't be asked).
    const audience = await staff(`/nrms/api/releases/${id}/audience`, editor);
    expect(audience.status).toBe(200);
    expect(((await audience.json()) as { asItHappens: { count: number | null } | null }).asItHappens).toEqual({ count: 0 });

    // NRMS -> News API: 200, never the 502 "Couldn't look for similar releases".
    expect((await staff(`/nrms/api/releases/${id}/similar`, editor, { method: "POST", body: "{}" })).status).toBe(200);

    // NRMS -> Core (the active Core.Admin emails) -> Distribution (the Blue Bridge notice).
    const bridge = (await (await staff("/nrms/api/site/blue-bridge", editor)).json()) as { version: number };
    const on = await staff("/nrms/api/site/blue-bridge", editor, { method: "PUT", body: JSON.stringify({ version: bridge.version, on: true, confirmation: "KING CHARLES III", acknowledgeIgrs: true }) });
    expect(on.status).toBe(200);
    await expect
      .poll(async () => {
        await tick();
        return sink.messages.some((m) => (m.to && "value" in m.to ? m.to.value.some((v) => v.address === ADMIN_EMAIL) : false));
      }, { timeout: 15_000, interval: 500 })
      .toBe(true);
  });
});
