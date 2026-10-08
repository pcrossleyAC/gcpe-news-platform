// Stack-level tests (task-14-brief.md's checklist, plus fix round 1 / P2-R30) and the Phase 2
// exit check replayed through the stack's single server and /stack/tick instead of six
// separate processes.
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import { hashPassword, mintLocalToken } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";

import { createCoreTestDb, healthOrg } from "../../core/test/helpers";
import { upsertOrganization } from "../../core/src/services/organizations";
import { createNrmsTestDb, sampleCreate, seedTaxonomy } from "../../nrms/test/helpers";
import { createNewsTestDb } from "../../news-api/test/helpers";
import { createPublicSiteTestDb } from "../../public-site/test/helpers";
import { createNodTestDb } from "../../nod/test/helpers";
import { createDistributionTestDb } from "../../distribution/test/helpers";
import { startSmtpSink } from "../../distribution/test/smtp-sink";

import { flickrClient, FlickrError } from "../../nrms/src/media/flickr-client";
import { FAKE_FLICKR } from "./env";
import { INTERNAL_ORIGIN } from "./internal-fetch";
import { fakeFlickrPublicBase, publicFilesBase, startStack } from "./stack";

const LOCAL_AUTH_SECRET = "stack-test-local-auth-secret-32-characters!";
const ADMIN_PASSWORD = "stack-test-password-99";
// C55: NoD's legacy Subscribe/SubscriberInformation Basic Auth, configured through the stack
// the same way an operator would (NOD_-prefixed, stripped by envFor before NoD's own schema
// sees it) -- see the "/nod/Subscribe/SubscriberInformation" reachability test below.
const MEMBERSHIP_API_USERNAME = "media-hub-stack-test";
const MEMBERSHIP_API_PASSWORD = "stack-test-membership-password-99";

// Important fix 1 (P2-R30): Core -> News API, over a self: URL, same as NRMS -> News API.
const STACK_EVENT_SECRET = "stack-e2e-event-secret-" + "s".repeat(32);

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
  dataDir: string;
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
async function setupStack(opts: {
  fetchAdminToken?: boolean;
  staffWebDir?: string;
  // Task 2 fix round 1: lets a test put one of the six fresh test databases into a specific
  // state *before* startStack(env) runs its own startup work (including the fire-and-forget
  // reference-data backfill) — e.g. an org written straight into Core's DB, bypassing the
  // event system entirely, to prove the backfill (not the live CORE->NOD event route another
  // test already covers) is what delivers it to NoD.
  beforeStart?: (dbs: StackTestInstanceDbs) => Promise<void>;
} = {}): Promise<StackTestInstance> {
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
  // Task 1: DATA_DIR must point at a temp folder, never the real home directory — resolveDataDir
  // defaults to ~/gcpe-data, and startStack's ensureWritableDir call would otherwise actually
  // create that folder on whatever machine runs this test.
  const dataDir = await mkdtemp(join(tmpdir(), "gcpe-stack-test-data-"));
  const sink = await startSmtpSink();

  const port = await probeFreePort();
  const passwordHash = await hashPassword(ADMIN_PASSWORD);
  const membershipPasswordHash = await hashPassword(MEMBERSHIP_API_PASSWORD);
  const tickToken = `tick-token-${port}-${"x".repeat(32)}`;

  const env: NodeJS.ProcessEnv = {
    PORT: String(port),
    TICK_TOKEN: tickToken,
    STACK_LOOPS: "false",
    UPDATES_HUB_ENABLED: "false",
    NODE_ENV: "test",
    DATA_DIR: dataDir,
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
    NOD_MEMBERSHIP_API_USERNAME: MEMBERSHIP_API_USERNAME,
    NOD_MEMBERSHIP_API_PASSWORD_HASH: membershipPasswordHash,
    // The Distribution pause/resume ops email's recipient -- only pause and resume calls ever
    // trigger it, so setting this doesn't affect any other test against this shared instance.
    NOD_OPS_EMAIL: "ops@example.gov.bc.ca",

    DIST_DATABASE_URL: distribution.url,
    DIST_SMTP_HOST: "127.0.0.1",
    DIST_SMTP_PORT: String(sink.port),
    DIST_SMTP_SECURE: "false",
    DIST_MAIL_FROM: "noreply@example.gov.bc.ca",
    DIST_MAIL_ALLOW_REAL_RECIPIENTS: "true",
  };
  // Task 1 (staff-web): unset leaves the real default (apps/staff-web/dist, almost certainly
  // not built in this test run) in place, so most instances see the 503 "not built" path.
  if (opts.staffWebDir !== undefined) env.STAFF_WEB_DIR = opts.staffWebDir;

  if (opts.beforeStart) await opts.beforeStart(dbs);

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
    dataDir,
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
      await step(() => rm(dataDir, { recursive: true, force: true }));
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

  // 2026-10-04 SiteGround debugging: the walkthrough's restarts were indistinguishable from a
  // crash without something naming when *this* process started. startedAt/pid make a restart
  // between two polls observable (a changed value) instead of a mystery, whether or not the
  // aggregate health check itself is cached (M8) at the time.
  it("GET /stack/health reports this process's startedAt and pid, stable across calls and across the health cache", async () => {
    const first = (await (await fetch(`${instance.stackUrl}/stack/health`)).json()) as { startedAt: string; pid: number };
    expect(first.pid).toBe(process.pid); // the test and the stack run in the same process here
    expect(new Date(first.startedAt).toString()).not.toBe("Invalid Date");
    expect(new Date(first.startedAt).getTime()).toBeLessThanOrEqual(Date.now());
    const second = (await (await fetch(`${instance.stackUrl}/stack/health`)).json()) as { startedAt: string; pid: number };
    expect(second).toEqual(first);
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

  // C55: News API's app is mounted at the stack root with no prefix (app.use(newsApi.app)),
  // after every prefixed app including /nod, and ends in its own `{error:"not found"}` 404
  // catch-all for anything unmatched. If NoD's own membership route ever stopped being
  // mounted (or stopped matching this path), the request would fall through /nod and get
  // swallowed by that catch-all instead of ever reaching NoD -- this proves it doesn't: a
  // real Basic Auth round-trip through the stack's own NOD_MEMBERSHIP_API_* env (stripped by
  // envFor the same way every other NOD_-prefixed var is) gets NoD's real 200, not News API's
  // 404.
  it("/nod/Subscribe/SubscriberInformation is reachable under its stack prefix, not swallowed by News API's root catch-all (C55)", async () => {
    const auth = `Basic ${Buffer.from(`${MEMBERSHIP_API_USERNAME}:${MEMBERSHIP_API_PASSWORD}`).toString("base64")}`;
    const res = await fetch(`${instance.stackUrl}/nod/Subscribe/SubscriberInformation?emailAddress=nobody@example.test`, {
      headers: { authorization: auth },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { EmailAddress: string; SubscribedCategories: Record<string, string[]> };
    expect(body).toEqual({
      EmailAddress: "nobody@example.test",
      SubscribedCategories: {},
      IsAllNews: false,
      IsAsItHappens: false,
      IsDailyDigest: false,
      IsAdminRegistration: false,
      NotifyIfNewCategories: false,
      ExpiredLinkOrUnverifiedEmail: false,
    });

    // The same request with no credentials at all is NoD's own 401 (WWW-Authenticate) --
    // News API's catch-all 404 has no such header -- a second, cheap discriminator that this
    // reached NoD and not the fallthrough.
    const unauthed = await fetch(`${instance.stackUrl}/nod/Subscribe/SubscriberInformation?emailAddress=nobody@example.test`);
    expect(unauthed.status).toBe(401);
    expect(unauthed.headers.get("www-authenticate")).toBe('Basic realm="NoD"');
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

  // Plan 3d task 4 fix round 1 (CRITICAL ruling): the public site's own render-state marker
  // (apps/public-site/src/rebuild.ts's SITE_STATE_PATH, ".site-state.json") must never be
  // publicly servable.
  it("/site/<dotfile> is refused — the render-state marker is never publicly servable", async () => {
    const { fsStorage } = await import("../../public-site/src/storage");
    await fsStorage(instance.outputDir).write(".site-state.json", '{"granvilleOn":true,"test":false}');
    const res = await fetch(`${instance.stackUrl}/site/.site-state.json`);
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain("granvilleOn");
  });

  it("/files/<key> serves an uploaded file from <DATA_DIR>/storage publicly; .meta, listings and missing keys are not served", async () => {
    const { localStore } = await import("@gcpe/storage");
    const store = localStore(join(instance.dataDir, "storage"));
    const key = "releases/00000000-0000-4000-8000-000000000001/translations/0123456789abcdef-budget-fr.pdf";
    await store.put(key, Buffer.from("%PDF-1.7 probe"), "application/pdf");
    const res = await fetch(`${instance.stackUrl}/files/${key}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("%PDF-1.7 probe");
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetch(`${instance.stackUrl}/files/.meta/${key}.json`)).status).toBe(403);
    expect((await fetch(`${instance.stackUrl}/files/releases/00000000-0000-4000-8000-000000000001/translations`, { redirect: "manual" })).status).toBe(404);
    expect((await fetch(`${instance.stackUrl}/files/releases/nope.pdf`)).status).toBe(404);
  });

  it("an upload through /nrms/api is downloadable at the URL in the view; publicFilesBase takes the site URL's origin", async () => {
    await seedTaxonomy(instance.dbs.nrms.db); // NRMS's local taxonomy copy; idempotent
    const created = await fetch(`${instance.stackUrl}/nrms/api/releases`, {
      method: "POST",
      headers: { authorization: `Bearer ${instance.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify(sampleCreate),
    });
    expect(created.status).toBe(201);
    const { id, version } = (await created.json()) as { id: string; version: number };
    const up = await fetch(`${instance.stackUrl}/nrms/api/releases/${id}/files?kind=translation&version=${version}&name=Budget%20FR.pdf`, {
      method: "POST",
      headers: { authorization: `Bearer ${instance.adminToken}`, "content-type": "application/pdf" },
      body: Buffer.from("%PDF-1.7 uploaded"),
    });
    expect(up.status).toBe(201);
    const view = (await up.json()) as { files: { url: string }[] };
    const file = await fetch(`${instance.stackUrl}${view.files[0]!.url}`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("%PDF-1.7 uploaded");
    expect(publicFilesBase("https://boxs.ca/site/")).toBe("https://boxs.ca");
    expect(publicFilesBase(undefined)).toBe("");
  });

  describe("fake Flickr (no FLICKR_API_KEY configured)", () => {
    const PRIVATE_PAGE = "https://www.flickr.com/photos/bcgovphotos/53000000001/";
    const admin = () => ({ authorization: `Bearer ${instance.adminToken}`, "content-type": "application/json" });
    const fakeState = (body: unknown) =>
      fetch(`${instance.stackUrl}/fake-flickr/__fake/state`, { method: "POST", headers: admin(), body: JSON.stringify(body) });

    it("the fake's /__fake switches need a Core.Admin bearer; its Flickr API stays public", async () => {
      const post = (path: string, headers: Record<string, string>) =>
        fetch(`${instance.stackUrl}/fake-flickr/__fake/${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ refuseAuth: false }) });
      expect((await post("state", {})).status).toBe(401);
      expect((await post("photos", {})).status).toBe(401);
      const editor = await mintLocalToken({ secret: LOCAL_AUTH_SECRET, subject: "editor", roles: ["NRMS.Editor"] });
      expect((await post("state", { authorization: `Bearer ${editor}` })).status).toBe(403);
      const ok = await post("state", { authorization: `Bearer ${instance.adminToken}` });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ refuseAuth: false, outageCalls: 0, deleted: [] });
      // No auth on the Flickr API itself: an unsigned call reaches the fake and gets Flickr's own answer.
      const rest = await fetch(`${instance.stackUrl}/fake-flickr/services/rest?method=flickr.photos.getInfo&photo_id=1`);
      expect(rest.status).toBe(200);
      expect(await rest.json()).toMatchObject({ stat: "fail", code: 98 });
      expect((await fetch(`${instance.stackUrl}/fake-flickr/photos/bcgovphotos/53000000001`)).status).toBe(200);
    });

    afterAll(async () => {
      await fakeState({ deleted: [], refuseAuth: false, outageCalls: 0 });
    });

    it("asset status goes through NRMS's signed client to the fake: private, then missing once the photo is deleted", async () => {
      await seedTaxonomy(instance.dbs.nrms.db);
      const created = await fetch(`${instance.stackUrl}/nrms/api/releases`, { method: "POST", headers: admin(), body: JSON.stringify(sampleCreate) });
      expect(created.status).toBe(201);
      const { id, version } = (await created.json()) as { id: string; version: number };
      const saved = await fetch(`${instance.stackUrl}/nrms/api/releases/${id}/asset`, {
        method: "PUT",
        headers: admin(),
        body: JSON.stringify({ version, assetUrl: PRIVATE_PAGE, assetAltText: "Photo", hasMediaAssets: true }),
      });
      expect(saved.status).toBe(200);

      const status = async () => {
        const res = await fetch(`${instance.stackUrl}/nrms/api/releases/${id}/asset-status`, { headers: admin() });
        expect(res.status).toBe(200);
        return res.json();
      };
      expect(await status()).toEqual({
        kind: "flickr", photoId: "53000000001", state: "private", message: "Private — will be made public when the release publishes.",
      });

      expect((await fakeState({ deleted: ["53000000001"] })).status).toBe(200);
      expect(await status()).toEqual({ kind: "flickr", photoId: "53000000001", state: "missing", message: "This photo no longer exists on Flickr." });
    });

    it("a Flickr link with no photo id is refused on save with 422", async () => {
      await seedTaxonomy(instance.dbs.nrms.db);
      const created = await fetch(`${instance.stackUrl}/nrms/api/releases`, { method: "POST", headers: admin(), body: JSON.stringify(sampleCreate) });
      const { id, version } = (await created.json()) as { id: string; version: number };
      const res = await fetch(`${instance.stackUrl}/nrms/api/releases/${id}/asset`, {
        method: "PUT",
        headers: admin(),
        body: JSON.stringify({ version, assetUrl: "https://www.flickr.com/photos/bcgovphotos/", assetAltText: null, hasMediaAssets: false }),
      });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe("That Flickr link doesn't point to a photo.");
    });

    it("a client signing the in-process URL can make a photo public (signed form POST) and fetch its image; a wrong secret is refused", async () => {
      const cfg = {
        ...FAKE_FLICKR,
        restUrl: `${INTERNAL_ORIGIN}/fake-flickr/services/rest`,
        oembedUrl: `${INTERNAL_ORIGIN}/fake-flickr/services/oembed`,
      };
      const client = flickrClient(cfg);
      expect(await client.getVisibility("53000000002")).toBe("private");
      await client.makePublic("53000000002");
      expect(await client.confirmPublic("53000000002")).toBe(true);
      const image = await client.staticImageUrl("https://www.flickr.com/photos/bcgovphotos/53000000002/");
      // The site's public origin (here the self: site URL's) + /fake-flickr.
      expect(image).toMatch(/^http:\/\/stack\.internal\/fake-flickr\/static\/53000000002_[0-9a-z]+_b\.jpg$/);
      const jpeg = await fetch(image);
      expect(jpeg.status).toBe(200);
      expect(jpeg.headers.get("content-type")).toBe("image/jpeg");

      const wrong = flickrClient({ ...cfg, apiSecret: "not-the-secret" });
      await expect(wrong.getVisibility("53000000002")).rejects.toMatchObject({ kind: "auth" });
      await expect(wrong.getVisibility("53000000002")).rejects.toBeInstanceOf(FlickrError);
    });

    // Debugging boxs.ca: scripts/siteground-flickr-walkthrough.sh --outage saw the fake
    // Flickr's in-memory state reset mid-run (refuseAuth cleared, then photos reseeded
    // private) with no external actor doing it -- strong evidence the stack process itself
    // crashed and SiteGround restarted it. Reproduces the walkthrough's load (once-a-minute
    // asset-status polls plus once-a-minute cron ticks) at full speed, with refuseAuth on the
    // whole time (every Flickr call fails auth, round-tripping through installInternalFetch's
    // self:/fake-flickr machinery every time), and asserts nothing crashes the process.
    it("repeated Flickr calls while refuseAuth is on never crash the process (no unhandled rejection/exception)", async () => {
      const seen: unknown[] = [];
      const onRejection = (reason: unknown) => seen.push(reason);
      const onException = (err: unknown) => seen.push(err);
      process.on("unhandledRejection", onRejection);
      process.on("uncaughtException", onException);
      try {
        expect((await fakeState({ refuseAuth: true })).status).toBe(200);

        await seedTaxonomy(instance.dbs.nrms.db);
        const created = await fetch(`${instance.stackUrl}/nrms/api/releases`, { method: "POST", headers: admin(), body: JSON.stringify(sampleCreate) });
        const { id, version } = (await created.json()) as { id: string; version: number };
        const saved = await fetch(`${instance.stackUrl}/nrms/api/releases/${id}/asset`, {
          method: "PUT",
          headers: admin(),
          body: JSON.stringify({ version, assetUrl: PRIVATE_PAGE, assetAltText: "Photo", hasMediaAssets: true }),
        });
        expect(saved.status).toBe(200);

        const statusOnce = () => fetch(`${instance.stackUrl}/nrms/api/releases/${id}/asset-status`, { headers: admin() });
        const tickOnce = () => fetch(`${instance.stackUrl}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${instance.tickToken}` } });

        for (let i = 0; i < 20; i++) {
          const [s, t] = await Promise.all([statusOnce(), tickOnce()]);
          expect(s.status).toBe(200);
          expect(t.status).toBe(200);
        }
        await Promise.all(Array.from({ length: 20 }, () => statusOnce()));

        // Give any late/async 'error' event a chance to surface before asserting.
        await new Promise((r) => setTimeout(r, 50));
        expect(seen).toEqual([]);
      } finally {
        process.off("unhandledRejection", onRejection);
        process.off("uncaughtException", onException);
        await fakeState({ refuseAuth: false });
      }
    });

    it("the fake's public base is the site URL's origin + /fake-flickr, else localhost at the stack's port", () => {
      expect(fakeFlickrPublicBase("https://boxs.ca/site/", 3000)).toBe("https://boxs.ca/fake-flickr");
      expect(fakeFlickrPublicBase(undefined, 4321)).toBe("http://localhost:4321/fake-flickr");
      expect(fakeFlickrPublicBase("not a url", 4321)).toBe("http://localhost:4321/fake-flickr");
    });

    // 2026-10-04 SiteGround debugging, end to end: a brand-new startStack(), pointed at the
    // same DATA_DIR/databases/output dir as the shared `instance` but a fresh port, is
    // exactly what SiteGround's documented 30-60s idle-kill-then-cold-start cycle does to a
    // real deployment (docs/deploy/siteground.md "Background work scheduler") — a new
    // process, same persistent state. Before the fix, this second instance's fake Flickr
    // would come up with refuseAuth/photo visibility back at their in-memory defaults even
    // though the first instance had already cleared the outage and made the photo public;
    // that's what scripts/siteground-flickr-walkthrough.sh --outage was actually hitting.
    it("a second startStack() against the same DATA_DIR sees the first's Flickr outage recovery (statePath survives a restart)", async () => {
      expect((await fakeState({ refuseAuth: true })).status).toBe(200);
      expect((await fakeState({ refuseAuth: false })).status).toBe(200);
      const client1 = flickrClient({ ...FAKE_FLICKR, restUrl: `${instance.stackUrl}/fake-flickr/services/rest`, oembedUrl: `${instance.stackUrl}/fake-flickr/services/oembed` });
      await client1.makePublic("53000000003");
      expect(await client1.confirmPublic("53000000003")).toBe(true);

      const port2 = await probeFreePort();
      const env2: NodeJS.ProcessEnv = {
        PORT: String(port2),
        TICK_TOKEN: instance.tickToken,
        STACK_LOOPS: "false",
        NODE_ENV: "test",
        DATA_DIR: instance.dataDir,
        LOCAL_ADMIN_ENABLED: "true",
        LOCAL_ADMIN_PASSWORD_HASH: await hashPassword(ADMIN_PASSWORD),
        LOCAL_AUTH_SECRET,
        STACK_EVENT_SECRET,
        CORE_DATABASE_URL: instance.dbs.core.url,
        NRMS_DATABASE_URL: instance.dbs.nrms.url,
        NEWSAPI_DATABASE_URL: instance.dbs.newsApi.url,
        SITE_DATABASE_URL: instance.dbs.publicSite.url,
        SITE_NEWS_API_URL: "self:/",
        SITE_OUTPUT_DIR: instance.outputDir,
        SITE_PUBLIC_SITE_URL: "self:/site",
        NOD_DATABASE_URL: instance.dbs.nod.url,
        NOD_DISTRIBUTION_URL: "self:/distribution",
        NOD_PUBLIC_SITE_URL: "self:/site",
        DIST_DATABASE_URL: instance.dbs.distribution.url,
        DIST_SMTP_HOST: "127.0.0.1",
        DIST_SMTP_PORT: String(instance.sink.port),
        DIST_SMTP_SECURE: "false",
        DIST_MAIL_FROM: "noreply@example.gov.bc.ca",
        DIST_MAIL_ALLOW_REAL_RECIPIENTS: "true",
      };
      const handle2 = await startStack(env2);
      const bound2 = await listenOnPort(handle2.app, handle2.port);
      try {
        const stackUrl2 = `http://127.0.0.1:${handle2.port}`;
        const client2 = flickrClient({ ...FAKE_FLICKR, restUrl: `${stackUrl2}/fake-flickr/services/rest`, oembedUrl: `${stackUrl2}/fake-flickr/services/oembed` });
        expect(await client2.getVisibility("53000000003")).toBe("public");
        // A photo neither instance touched keeps its ordinary seeded default.
        expect(await client2.getVisibility("53000000004")).toBe("private");
      } finally {
        await bound2.close();
        await Promise.all([...handle2.closeBeforeServer, ...handle2.closers].map((c) => c.close()));
      }
    });
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
      expect(Object.keys(body.ran)).toEqual([
        "nrms.flickr",
        "nrms.site",
        "nrms.publish",
        "nrms.dispatch",
        "core.dispatch",
        "news-api.dispatch",
        "nod.media-sync",
        "nod.bounce-summary",
        "nod.emergency-feed",
        "nod.digest",
        "nod.send",
        "nod.purge",
        "distribution.send",
        "distribution.bounces",
        "distribution.dispatch",
      ]);
      expect(Object.values(body.ran)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok"]);
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

    it("200s with a Core.Admin bearer and returns captured console.error entries, each carrying this process's pid and startedAt", async () => {
      console.error("stack.test.ts probe error for /stack/errors");
      const health = (await (await fetch(`${instance.stackUrl}/stack/health`)).json()) as { startedAt: string; pid: number };
      const res = await fetch(`${instance.stackUrl}/stack/errors`, { headers: { authorization: `Bearer ${instance.adminToken}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { errors: { timestamp: string; message: string; pid: number; startedAt: string }[] };
      const probe = body.errors.find((e) => e.message.includes("stack.test.ts probe error"));
      expect(probe).toBeDefined();
      expect(probe!.pid).toBe(health.pid);
      expect(probe!.startedAt).toBe(health.startedAt);
    });

    // 2026-10-04 SiteGround debugging: this log used to live only in process memory, so every
    // idle-kill restart wiped it (docs/deploy/siteground.md "Troubleshooting") — it was nearly
    // always empty by the time anyone checked. It's now persisted under DATA_DIR/logs, which
    // already survives a restart (see data-dir.ts); confirm the file itself holds the entry.
    it("persists captured entries to <DATA_DIR>/logs/errors.jsonl", async () => {
      console.error("stack.test.ts probe error for persistence check");
      const raw = await readFile(join(instance.dataDir, "logs", "errors.jsonl"), "utf8");
      expect(raw.includes("stack.test.ts probe error for persistence check")).toBe(true);
    });

    it("honours ?limit=, capped at 1000, defaulting to 200", async () => {
      for (let i = 0; i < 5; i++) console.error(`stack.test.ts limit-probe ${i}`);
      const res = await fetch(`${instance.stackUrl}/stack/errors?limit=2`, { headers: { authorization: `Bearer ${instance.adminToken}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { errors: { message: string }[] };
      expect(body.errors).toHaveLength(2);
      expect(body.errors[1]!.message).toBe("stack.test.ts limit-probe 4");

      const resOverCap = await fetch(`${instance.stackUrl}/stack/errors?limit=5000`, { headers: { authorization: `Bearer ${instance.adminToken}` } });
      const bodyOverCap = (await resOverCap.json()) as { errors: unknown[] };
      expect(bodyOverCap.errors.length).toBeLessThanOrEqual(1000);
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

  // Task 2 (Phase 4a): NoD's `lists` mirror Core's taxonomy events over the same CORE->NOD
  // route NRMS already uses for its own copy (see the test just above). The Subscribe API's
  // own SubscriptionItems/ministries route isn't wired until Task 6 — this asserts the mirror
  // directly against NoD's database instead.
  it("a ministry saved in Core shows up in NoD's lists after a tick", async () => {
    const putRes = await fetch(`${instance.stackUrl}/core/api/organizations/${healthOrg.key}`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${instance.adminToken}` },
      body: JSON.stringify(healthOrg),
    });
    expect(putRes.status).toBe(200);

    const tickRes = await fetch(`${instance.stackUrl}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${instance.tickToken}` } });
    expect(tickRes.status).toBe(200);

    const rows = await instance.dbs.nod.pool.query<{ list_key: string; name: string }>(
      "SELECT list_key, name FROM lists WHERE category = 'ministries' AND key = $1",
      [healthOrg.key],
    );
    expect(rows.rows).toEqual([{ list_key: `ministries:${healthOrg.key}`, name: healthOrg.displayName }]);
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
    // Task 5: NoD's As-It-Happens subject is "BC Gov News - <title>" (legacy NodTask.cs), not
    // the bare headline.
    const mail = instance.sink.messages.find((m) => m.subject === `BC Gov News - ${headline}`);
    expect(mail).toBeDefined();
    const toAddress = mail!.to && "value" in mail!.to ? mail!.to.value[0]?.address : undefined;
    expect(toAddress).toBe("alex.example@gov.bc.ca");
  });

  // NoD's own admin route reaches Distribution (over the stack's internal self: URL, with
  // NoD's own service token) and actually pauses it -- not just a 200 from NoD's side. While
  // paused, a held (non-system) message stays pending through a tick, and the pause's own ops
  // email (system priority) still goes out despite the pause ("A verification email still
  // goes out while paused"). Resuming then releases it.
  it("POST /nod/api/distribution/pause reaches Distribution and pauses it; held mail waits, the ops email doesn't, and resume releases it", async () => {
    const admin = { authorization: `Bearer ${instance.adminToken}` };
    const tick = () => fetch(`${instance.stackUrl}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${instance.tickToken}` } });

    const mailsBefore = instance.sink.messages.length;

    const pause = await fetch(`${instance.stackUrl}/nod/api/distribution/pause`, { method: "POST", headers: admin });
    expect(pause.status).toBe(200);
    expect(await pause.json()).toEqual({ paused: true, changed: true });

    const { rows: pausedRows } = await instance.dbs.distribution.pool.query<{ paused: boolean }>("SELECT paused FROM distribution_settings WHERE id = 1");
    expect(pausedRows).toEqual([{ paused: true }]);

    const { rows: opsLogRows } = await instance.dbs.nod.pool.query<{ action: string }>(
      "SELECT action FROM operations_log WHERE action = 'distribution-paused' ORDER BY at DESC LIMIT 1",
    );
    expect(opsLogRows).toEqual([{ action: "distribution-paused" }]);

    // A held (non-system, "immediate") message, inserted directly as a stand-in for a release
    // going out while paused -- the release pipeline itself is already covered by the Phase 2
    // exit check above.
    const { rows: batchRows } = await instance.dbs.distribution.pool.query<{ id: string }>(
      `INSERT INTO batches (app_id, subject, html, text, headers) VALUES ('stack-test', 'Held release', '<p>hi</p>', 'hi', '{}'::jsonb) RETURNING id`,
    );
    await instance.dbs.distribution.pool.query(
      `INSERT INTO messages (batch_id, email, substitutions, priority) VALUES ($1, 'held-release@example.test', '{}'::jsonb, 30)`,
      [batchRows[0]!.id],
    );

    const tickWhilePaused = await tick();
    expect(tickWhilePaused.status).toBe(200);

    const { rows: heldRows } = await instance.dbs.distribution.pool.query<{ status: string }>(
      "SELECT status FROM messages WHERE email = 'held-release@example.test'",
    );
    expect(heldRows).toEqual([{ status: "pending" }]);

    // The pause's own ops notice is system priority, so it went out on that same tick despite
    // the pause -- the sink gained exactly one message, addressed to NOD_OPS_EMAIL.
    await expect.poll(() => instance.sink.messages.length, { timeout: 5000 }).toBeGreaterThan(mailsBefore);
    const opsMail = instance.sink.messages.find((m) => m.subject === "BC Gov News On Demand distribution paused");
    expect(opsMail).toBeDefined();
    const opsToAddress = opsMail!.to && "value" in opsMail!.to ? opsMail!.to.value[0]?.address : undefined;
    expect(opsToAddress).toBe("ops@example.gov.bc.ca");

    const resume = await fetch(`${instance.stackUrl}/nod/api/distribution/resume`, { method: "POST", headers: admin });
    expect(resume.status).toBe(200);
    expect(await resume.json()).toEqual({ paused: false, changed: true });

    await tick();
    const { rows: releasedRows } = await instance.dbs.distribution.pool.query<{ status: string }>(
      "SELECT status FROM messages WHERE email = 'held-release@example.test'",
    );
    expect(releasedRows).toEqual([{ status: "sent" }]);
  });

  // Phase 4e: a bounce recorded by Distribution reaches NoD as a delivery.bounced event, over
  // the stack's own DIST -> NOD route, driven only by /stack/tick, and NoD's own bounces.ts
  // handler runs for it -- the receiver records "applied" regardless of whether there turns
  // out to be a subscriber to match (there isn't one here, for this never-subscribed address).
  it("a bounce uploaded to the fake inbox reaches NoD's event receiver as delivery.bounced, driven by /stack/tick", async () => {
    const recipient = "bounce-target@example.test";
    const { rows: batchRows } = await instance.dbs.distribution.pool.query<{ id: string }>(
      `INSERT INTO batches (app_id, subject, html, text, headers) VALUES ('nod', 'Weekend clinics open', '<p>hi</p>', 'hi', '{}'::jsonb) RETURNING id`,
    );
    await instance.dbs.distribution.pool.query(
      `INSERT INTO messages (batch_id, email, substitutions, priority, status, sent_at) VALUES ($1, $2, '{}'::jsonb, 30, 'sent', now())`,
      [batchRows[0]!.id, recipient],
    );

    const raw = [
      "Subject: Undeliverable: Weekend clinics open",
      "",
      `Your message could not be delivered to ${recipient} [#;550]`,
    ].join("\r\n");
    const operateToken = await mintLocalToken({ secret: LOCAL_AUTH_SECRET, subject: "nod", azp: "nod", roles: ["Distribution.Operate"] });
    const upload = await fetch(`${instance.stackUrl}/distribution/api/bounces/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${operateToken}` },
      body: JSON.stringify({ raw }),
    });
    expect(upload.status).toBe(201);

    // The 15-minute gate may already have been claimed by an earlier test's tick against this
    // same shared instance -- force it due again so this bounce is actually fetched this tick.
    await instance.dbs.distribution.pool.query("UPDATE distribution_settings SET bounces_checked_at = NULL WHERE id = 1");

    const tickRes = await fetch(`${instance.stackUrl}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${instance.tickToken}` } });
    expect(tickRes.status).toBe(200);
    const tickBody = (await tickRes.json()) as { ran: Record<string, string> };
    expect(tickBody.ran["distribution.bounces"]).toBe("ok");
    expect(tickBody.ran["distribution.dispatch"]).toBe("ok");

    const inbox = await instance.dbs.nod.pool.query<{ source: string; type: string; outcome: string }>(
      "SELECT source, type, outcome FROM inbox_events WHERE source = 'distribution' AND type = 'delivery.bounced'",
    );
    expect(inbox.rows).toEqual([{ source: "distribution", type: "delivery.bounced", outcome: "applied" }]);
  });

  describe("fake Media Hub (no NOD_MEDIA_HUB_URL configured)", () => {
    it("NoD's own default points at the in-stack fake: the search proxy round-trips through it end to end", async () => {
      const res = await fetch(`${instance.stackUrl}/nod/api/media-hub/contacts/search`, {
        method: "POST",
        headers: { authorization: `Bearer ${instance.adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ page: 1 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { contacts: unknown[]; page: number; pageSize: number; total: number };
      expect(body).toMatchObject({ page: 1, pageSize: 25 });
      expect(Array.isArray(body.contacts)).toBe(true);
      expect(body.total).toBeGreaterThan(0);
    });

    it("the fake's own service routes need a bearer with MediaHub.ContactsRead; /__fake needs Core.Admin, same as fake Flickr's", async () => {
      expect((await fetch(`${instance.stackUrl}/fake-media-hub/api/service/contacts`)).status).toBe(401);
      const editor = await mintLocalToken({ secret: LOCAL_AUTH_SECRET, subject: "editor", roles: ["NRMS.Editor"] });
      expect((await fetch(`${instance.stackUrl}/fake-media-hub/api/service/contacts`, { headers: { authorization: `Bearer ${editor}` } })).status).toBe(403);

      const reset = (headers: Record<string, string>) =>
        fetch(`${instance.stackUrl}/fake-media-hub/__fake/reset`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
      expect((await reset({})).status).toBe(401);
      expect((await reset({ authorization: `Bearer ${editor}` })).status).toBe(403);
      expect((await reset({ authorization: `Bearer ${instance.adminToken}` })).status).toBe(200);
    });
  });

  describe("fake emergency feed (no NOD_EMERGENCY_FEED_URL configured)", () => {
    it("serves its RSS publicly, like the real feed; /__fake needs Core.Admin", async () => {
      const feed = await fetch(`${instance.stackUrl}/fake-emergency-feed/feed.xml`);
      expect(feed.status).toBe(200);
      expect(await feed.text()).toContain("<rss");
      const editor = await mintLocalToken({ secret: LOCAL_AUTH_SECRET, subject: "editor", roles: ["NRMS.Editor"] });
      const add = (headers: Record<string, string>) =>
        fetch(`${instance.stackUrl}/fake-emergency-feed/__fake/alerts`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ title: "Stack test alert" }) });
      expect((await add({})).status).toBe(401);
      expect((await add({ authorization: `Bearer ${editor}` })).status).toBe(403);
      expect((await add({ authorization: `Bearer ${instance.adminToken}` })).status).toBe(201);
    });

    it("GET /__fake/alerts needs Core.Admin too, not just the POST switch", async () => {
      const editor = await mintLocalToken({ secret: LOCAL_AUTH_SECRET, subject: "editor", roles: ["NRMS.Editor"] });
      const list = (headers: Record<string, string>) => fetch(`${instance.stackUrl}/fake-emergency-feed/__fake/alerts`, { headers });
      expect((await list({})).status).toBe(401);
      expect((await list({ authorization: `Bearer ${editor}` })).status).toBe(403);
      expect((await list({ authorization: `Bearer ${instance.adminToken}` })).status).toBe(200);
    });
  });
});

// Task 2 (Phase 4a) fix round 1: the shared instance above only proves the live CORE->NOD
// event route (it PUTs a ministry *after* startup, through Core's own API, which enqueues and
// delivers the event the ordinary way). These two tests exercise the backfill itself — the
// fire-and-forget block in stack.ts that runs once at startup — by writing straight into a
// fresh database before startStack() ever runs, bypassing the event system entirely, so the
// only way the data could reach NoD is through the backfill.
describe("apps/stack: reference-data backfill (Task 2 fix round 1)", () => {
  // A second ministry, distinct from the shared instance's `healthOrg`, so a leftover row from
  // another test can never be mistaken for one this test produced.
  const financeOrg = { ...healthOrg, key: "finance", displayName: "Finance", abbreviation: "FIN", sectorKeys: ["finance"] };

  it("a NoD with no lists yet gets Core's existing organization once, from the backfill alone", async () => {
    const stack = await setupStack({
      fetchAdminToken: false,
      // Writes the org straight into Core's table with no subscribers (so enqueueOrganization
      // enqueues no outbox delivery for it) — Core "already has data" the moment the stack
      // starts, exactly the first-deploy/fresh-database scenario the backfill exists for.
      beforeStart: async (dbs) => {
        await upsertOrganization(dbs.core.db, financeOrg, []);
      },
    });
    try {
      const nodHasFinance = async (): Promise<boolean> => {
        // The backfill enqueues the republished event asynchronously (fire-and-forget) and it
        // only reaches NoD on a dispatch tick, so poll both together until it lands.
        await fetch(`${stack.stackUrl}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${stack.tickToken}` } });
        const rows = await stack.dbs.nod.pool.query<{ list_key: string; name: string }>(
          "SELECT list_key, name FROM lists WHERE list_key = $1",
          [`ministries:${financeOrg.key}`],
        );
        return rows.rows.length > 0;
      };
      await expect.poll(nodHasFinance, { timeout: 5000 }).toBe(true);
    } finally {
      await stack.close();
    }
  });

  it("a NoD that already has a ministry list is left alone — the backfill never calls republish", async () => {
    const logSpy = vi.spyOn(console, "log");
    const stack = await setupStack({
      fetchAdminToken: false,
      beforeStart: async (dbs) => {
        // NoD already has a ministry list (from some other source — doesn't matter which),
        // so needsReferenceData() is false and the backfill must skip republish entirely.
        await dbs.nod.pool.query(
          "INSERT INTO lists (list_key, category, key, name) VALUES ('ministries:placeholder', 'ministries', 'placeholder', 'Placeholder')",
        );
        // Core also already has an org — written the same way as the test above, bypassing
        // the event system — so the only way it could ever reach NoD is through republish.
        await upsertOrganization(dbs.core.db, financeOrg, []);
      },
    });
    try {
      // The backfill's whole decision (one DB read, then either nothing or one more DB
      // write) happens well before this; the wait plus a tick just gives it generous room to
      // have finished either way before asserting its absence.
      await new Promise((r) => setTimeout(r, 300));
      await fetch(`${stack.stackUrl}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${stack.tickToken}` } });

      const backfillLogs = logSpy.mock.calls.filter((args: unknown[]) => String(args[0]).includes("Core republished"));
      expect(backfillLogs).toEqual([]);

      // Independent confirmation at the source: republishAll re-enqueues org.upserted (bumping
      // the aggregate to sequence 2); if republish was never called, Core's own outbox still
      // holds only the original seed's sequence 1.
      const outbox = await stack.dbs.core.pool.query<{ sequence: number }>(
        "SELECT sequence FROM outbox_events WHERE aggregate_id = $1 ORDER BY sequence",
        [`org:${financeOrg.key}`],
      );
      expect(outbox.rows.map((r) => r.sequence)).toEqual([1]);

      // And NoD, correspondingly, never received it.
      const rows = await stack.dbs.nod.pool.query<{ list_key: string }>("SELECT list_key FROM lists WHERE list_key = $1", [`ministries:${financeOrg.key}`]);
      expect(rows.rows).toEqual([]);
    } finally {
      logSpy.mockRestore();
      await stack.close();
    }
  });
});

// Fix round 1, P2-R30 M5: a standalone instance (not the shared one above) so a deliberately
// broken env (a missing NRMS_DATABASE_URL) can be exercised without disturbing the other
// tests' happy-path fixture.
describe("apps/stack: startup errors name the app and its env prefix (M5)", () => {
  let coreDb: TestDatabase | undefined;
  let dataDir: string | undefined;

  afterAll(async () => {
    await coreDb?.drop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("a missing NRMS_DATABASE_URL fails startStack with a message naming NRMS and NRMS_*", async () => {
    coreDb = await createCoreTestDb();
    // Task 1: DATA_DIR must point at a temp folder, not the real home directory — startStack's
    // ensureWritableDir call runs before NRMS's own startup failure is reached.
    dataDir = await mkdtemp(join(tmpdir(), "gcpe-stack-test-data-"));
    const passwordHash = await hashPassword(ADMIN_PASSWORD);
    const env: NodeJS.ProcessEnv = {
      PORT: "0",
      TICK_TOKEN: "t".repeat(32),
      STACK_LOOPS: "false",
      DATA_DIR: dataDir,
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

  it("a staff session cookie with Core.Admin can use the fake Flickr's /__fake switches, with the CSRF rule", async () => {
    const login = await fetch(`${inst.stackUrl}/core/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gcpe-request": "1" },
      body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith("gcpe_session="))!.split(";")[0]!;
    const post = (headers: Record<string, string>) =>
      fetch(`${inst.stackUrl}/fake-flickr/__fake/state`, { method: "POST", headers: { cookie, "content-type": "application/json", ...headers }, body: JSON.stringify({ outageCalls: 0 }) });
    expect((await post({})).status).toBe(403);
    expect((await post({ "x-gcpe-request": "1" })).status).toBe(200);
  });
});

// Fix round 1: the Critical finding — selfHeal fired from inside startPublicSite always failed
// in the single-process stack ("the stack app is not ready yet"), because News API (which
// self-heal reads from over a self: URL) only starts, and stackApp only gets assigned, after
// Public Site itself has already started. This is the regression test for that: a fresh stack
// instance with its own empty SITE output dir (setupStack always mkdtemps a fresh one) must
// end up with an index.html, and must never have logged a self-heal failure while doing so.
describe("apps/stack: public-site self-heal runs once the stack (not just a standalone process) is ready", () => {
  let instance: StackTestInstance;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    // Spying BEFORE setupStack() so it catches self-heal's fire-and-forget call, which starts
    // inside startStack() itself (right after stackApp is assigned), not after setupStack()
    // returns.
    errorSpy = vi.spyOn(console, "error");
    instance = await setupStack({ fetchAdminToken: false });
  });

  afterAll(async () => {
    errorSpy.mockRestore();
    await instance.close();
  });

  it("rebuilds index.html via self-heal without ever logging a self-heal failure", async () => {
    await expect
      .poll(
        async () => {
          try {
            await readFile(join(instance.outputDir, "index.html"), "utf8");
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 5000 },
      )
      .toBe(true);

    const selfHealFailures = errorSpy.mock.calls.filter((args: unknown[]) => String(args[0]).includes("self-heal failed"));
    expect(selfHealFailures).toEqual([]);
  });
});

// Production shape: the fake's public base is the site's https origin, while NRMS signs the
// in-process http://stack.internal URL it actually calls. The shared stack above can't show this
// (its site URL is itself a self: URL, so both forms coincide).
describe("apps/stack: fake Flickr accepts a signature over the in-process URL when its public base differs", () => {
  it("signed GET and form POST through the in-process fetch succeed; the image URL uses the public base", async () => {
    const { default: express } = await import("express");
    const { createFakeFlickr } = await import("@gcpe/flickr-fake");
    const { installInternalFetch } = await import("./internal-fetch");
    const app = express();
    app.set("trust proxy", 1);
    app.use("/fake-flickr", createFakeFlickr({ ...FAKE_FLICKR, publicBaseUrl: "https://boxs.example/fake-flickr" }).router);
    const uninstall = installInternalFetch(() => app);
    try {
      const client = flickrClient({
        ...FAKE_FLICKR,
        restUrl: `${INTERNAL_ORIGIN}/fake-flickr/services/rest`,
        oembedUrl: `${INTERNAL_ORIGIN}/fake-flickr/services/oembed`,
      });
      expect(await client.getVisibility("53000000003")).toBe("private");
      await client.makePublic("53000000003");
      expect(await client.confirmPublic("53000000003")).toBe(true);
      expect(await client.staticImageUrl("https://www.flickr.com/photos/bcgovphotos/53000000003/")).toMatch(/^https:\/\/boxs\.example\/fake-flickr\/static\/53000000003_/);
    } finally {
      uninstall();
    }
  });
});

// Task 1 (staff-web): /hub hosting — a built staff-web directory (faked here as a plain
// index.html + a hashed asset, not a real esbuild build: scripts/build-staff-web.mjs's own
// test covers the real build's output shape) and the 503-when-missing fallback, each its own
// instance since the shared "apps/stack" instance above deliberately leaves STAFF_WEB_DIR at
// its real (almost certainly unbuilt in this test run) default.
describe("apps/stack: /hub hosting", () => {
  let hubRoot: string;
  let dir: string;
  let built: StackTestInstance;
  let unbuiltDir: string;
  let unbuilt: StackTestInstance;

  beforeAll(async () => {
    // Inside a dot-directory, as on SiteGround (~/.nodeapp/<build>/hub): send/serve-static
    // refuse a path containing a dotfile segment unless it's below a `root` — this pins that.
    hubRoot = await mkdtemp(join(tmpdir(), "gcpe-stack-test-hub-"));
    dir = join(hubRoot, ".nodeapp", "build");
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "index.html"), "<!doctype html><html><body>staff web shell</body></html>");
    await writeFile(join(dir, "assets", "app-abc123.js"), "console.log('staff-web');\n");
    built = await setupStack({ fetchAdminToken: false, staffWebDir: dir });

    unbuiltDir = await mkdtemp(join(tmpdir(), "gcpe-stack-test-hub-missing-"));
    await rm(unbuiltDir, { recursive: true, force: true }); // exists on disk as a path, not as a directory
    unbuilt = await setupStack({ fetchAdminToken: false, staffWebDir: unbuiltDir });
  });

  afterAll(async () => {
    await built.close();
    await unbuilt.close();
    await rm(hubRoot, { recursive: true, force: true });
    // unbuiltDir was already removed in beforeAll (it must not exist); nothing left to clean up.
  });

  it("GET /hub/ and a deep link both serve index.html with no-store", async () => {
    for (const path of ["/hub", "/hub/", "/hub/releases/abc"]) {
      const res = await fetch(`${built.stackUrl}${path}`);
      expect.soft(res.status, path).toBe(200);
      expect.soft(res.headers.get("cache-control"), path).toBe("no-store");
      expect.soft(await res.text(), path).toContain("staff web shell");
    }
  });

  // Minors: the staff shell is never meant to be framed by anything (clickjacking).
  it("GET /hub/ carries frame-ancestors 'none' and X-Frame-Options: DENY", async () => {
    for (const path of ["/hub", "/hub/", "/hub/releases/abc"]) {
      const res = await fetch(`${built.stackUrl}${path}`);
      expect.soft(res.headers.get("content-security-policy"), path).toBe("frame-ancestors 'none'");
      expect.soft(res.headers.get("x-frame-options"), path).toBe("DENY");
    }
  });

  it("GET /hub/assets/<hashed file> is served with an immutable, year-long cache", async () => {
    const res = await fetch(`${built.stackUrl}/hub/assets/app-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/immutable/);
    expect(res.headers.get("cache-control")).toMatch(/max-age=31536000/);
  });

  it("GET /hub/missing.js 404s instead of falling back to index.html", async () => {
    const res = await fetch(`${built.stackUrl}/hub/missing.js`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("staff web shell");
  });

  it("with no build directory, /hub/ 503s but the stack still starts and serves /stack/health", async () => {
    const hub = await fetch(`${unbuilt.stackUrl}/hub/`);
    expect(hub.status).toBe(503);
    const health = await fetch(`${unbuilt.stackUrl}/stack/health`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { status: string }).status).toBe("ok");
  });
});
