// Phase 2 exit check (spec §11): every app wired in one process, over real HTTP
// (listen(0)), five real Postgres test databases and an in-process SMTP sink. Proves the
// whole chain end to end: NRMS release -> scheduled publish -> News API post -> static HTML
// page -> NoD As-It-Happens -> Distribution -> email captured. Nothing in between is stubbed;
// every worker (publishDue, dispatchOnce, sendDueJobs, sendDue) is the same function main.ts
// runs on a timer, just invoked directly instead of waiting out an interval.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { authFromEnv } from "@gcpe/auth";
import { dispatchOnce, type SubscriberConfig } from "@gcpe/events";

import { createApp as createNrmsApp } from "../../apps/nrms/src/app";
import { publishDue } from "../../apps/nrms/src/publisher";
import { createNrmsTestDb, sampleCreate, seedTaxonomy } from "../../apps/nrms/test/helpers";

import { createApp as createNewsApiApp } from "../../apps/news-api/src/app";
import { createNewsTestDb } from "../../apps/news-api/test/helpers";

import { createApp as createPublicSiteApp } from "../../apps/public-site/src/app";
import { createRebuildHandler } from "../../apps/public-site/src/rebuild";
import { newsApiClient } from "../../apps/public-site/src/news-api-client";
import { fsStorage } from "../../apps/public-site/src/storage";
import { createPublicSiteTestDb } from "../../apps/public-site/test/helpers";

import { createApp as createNodApp } from "../../apps/nod/src/app";
import { distributionClient, type DistributionClient } from "../../apps/nod/src/distribution-client";
import { distributionTokenProvider } from "../../apps/nod/src/distribution-token";
import { sendDueJobs } from "../../apps/nod/src/send-jobs";
import { createNodTestDb } from "../../apps/nod/test/helpers";

import { createApp as createDistributionApp } from "../../apps/distribution/src/app";
import { sendDue } from "../../apps/distribution/src/sender";
import { createDistributionTestDb } from "../../apps/distribution/test/helpers";
import { startSmtpSink } from "../../apps/distribution/test/smtp-sink";

import { listen, localAuthEnv, reserve, type Listening } from "./support";

// Not a real page; never fetched by this test (or by Distribution/NoD) — only ever embedded
// as a string in the As-It-Happens email, whose {{manageUrl}}/{{unsubscribeUrl}} substitutions
// the test asserts the shape of.
const MANAGE_URL = "http://nod.invalid/manage";
// Task 4: per-recipient manage/unsubscribe links (apps/nod/src/recipient-links.ts), passed to
// sendDueJobs directly since this test builds NoD's app without going through start.ts.
const NOD_LINKS = { pageUrl: MANAGE_URL, subscribeApiUrl: "http://nod.invalid/api/Subscribe", linkSecret: "e2e-thin-slice-link-secret-32-chars" };

// Signing secrets between each pair of apps (sender's `subscribers[].secret` must equal the
// receiver's `eventSecrets[source]`) — distinct per pair so a misrouted signature would be
// caught, same house style as every app's own test/helpers.ts EVENT_SECRETS.
const SECRET_NRMS_TO_NEWS_API = "e2e-nrms-to-news-api-secret";
const SECRET_NRMS_TO_NOD = "e2e-nrms-to-nod-secret";
const SECRET_NEWS_API_TO_PUBLIC_SITE = "e2e-news-api-to-public-site-secret";

const TZ = "America/Vancouver";

// A headline with characters that must be HTML-escaped on the static page but must reach the
// email subject raw (ruling P2-R19, fix round 1 item 3) — proves rendering actually escapes
// rather than merely happening not to need to.
const HEADLINE = "Clinics & <weekend> care";
const releaseInput = { ...sampleCreate, headline: HEADLINE };

describe("Phase 2 exit check: NRMS release -> publish -> News API -> static page -> NoD -> Distribution -> email", () => {
  // Every TestDatabase actually created, regardless of whether a later one in the batch
  // failed — so afterAll can always drop whatever exists instead of leaking a throwaway DB.
  const createdDbs: TestDatabase[] = [];
  let nrmsDb: TestDatabase;
  let newsApiDb: TestDatabase;
  let publicSiteDb: TestDatabase;
  let nodDb: TestDatabase;
  let distributionDb: TestDatabase;

  let nrms: Listening | undefined;
  let newsApi: Awaited<ReturnType<typeof reserve>> | undefined;
  let publicSite: Awaited<ReturnType<typeof reserve>> | undefined;
  let nod: Listening | undefined;
  let distribution: Listening | undefined;

  let outputDir: string | undefined;
  let sink: Awaited<ReturnType<typeof startSmtpSink>> | undefined;
  let smtpTransport: Transporter | undefined;
  let nodToDistribution: DistributionClient;

  let editorToken: string;
  let nrmsSubscribers: SubscriberConfig[];
  let newsApiSubscribers: SubscriberConfig[];

  beforeAll(async () => {
    // Fix round 1 item 1 (P2-R19): create all five DBs with allSettled so a failure partway
    // through the batch doesn't leak the ones that *did* get created — every fulfilled one is
    // kept in createdDbs for afterAll before the first rejection (if any) is rethrown.
    const dbResults = await Promise.allSettled([
      createNrmsTestDb(),
      createNewsTestDb(),
      createPublicSiteTestDb(),
      createNodTestDb(),
      createDistributionTestDb(),
    ]);
    for (const r of dbResults) if (r.status === "fulfilled") createdDbs.push(r.value);
    const rejected = dbResults.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (rejected) throw rejected.reason;
    [nrmsDb, newsApiDb, publicSiteDb, nodDb, distributionDb] = dbResults.map((r) => (r as PromiseFulfilledResult<TestDatabase>).value) as [
      TestDatabase,
      TestDatabase,
      TestDatabase,
      TestDatabase,
      TestDatabase,
    ];

    outputDir = await mkdtemp(join(tmpdir(), "gcpe-e2e-public-site-"));
    sink = await startSmtpSink();
    // Pooled, like Distribution's own main.ts (fix round 1 item 6).
    smtpTransport = nodemailer.createTransport({
      host: "127.0.0.1",
      port: sink.port,
      secure: false,
      ignoreTLS: true,
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 5_000,
      pool: true,
      maxConnections: 3,
      maxRequeues: 0, // as apps/distribution/src/transport.ts
    });

    const localAuth = await localAuthEnv();
    // Fix round 1 item 6 (P2-R19): build auth exactly as every main.ts does — via
    // authFromEnv, not by hand-assembling `{ local: { secret } }` — and pass its
    // `bearer`/`loginRouter` straight through to every app that takes them, including NoD and
    // Distribution's own loginRouters (neither is exercised by this test, but wiring them in
    // matches the real deployment, where every app enables the same local admin login). Each
    // app calls authFromEnv for itself, same as each is its own process in production.
    const envVars = { LOCAL_ADMIN_ENABLED: "true", LOCAL_ADMIN_PASSWORD_HASH: localAuth.passwordHash, LOCAL_AUTH_SECRET: localAuth.secret };
    const nrmsAuth = authFromEnv(envVars);
    const nodAuth = authFromEnv(envVars);
    const distributionAuth = authFromEnv(envVars);

    // News API's `subscribers` config points at the public site's /events, and the public
    // site's rebuild handler points back at News API's /api — a construction-time cycle real
    // main.ts processes never hit (each is deployed knowing the other's fixed URL already).
    // reserve() claims both ephemeral ports up front so each side's URL is known before
    // either's createApp() is called; attach() wires in the real app once both exist.
    newsApi = await reserve();
    publicSite = await reserve();

    distribution = await listen(
      createDistributionApp({
        db: distributionDb.db,
        auth: distributionAuth.bearer,
        loginRouter: distributionAuth.loginRouter,
        internalDomains: [],
      }),
    );

    publicSite.attach(
      createPublicSiteApp({
        db: publicSiteDb.db,
        eventSecrets: { "news-api": SECRET_NEWS_API_TO_PUBLIC_SITE },
        handler: createRebuildHandler({
          newsApi: newsApiClient(newsApi.url),
          storage: fsStorage(outputDir),
          site: { name: "BC Gov News (E2E)", baseUrl: publicSite.url },
          test: false,
        }),
      }),
    );

    newsApiSubscribers = [{ name: "public-site", url: `${publicSite.url}/events`, secret: SECRET_NEWS_API_TO_PUBLIC_SITE, types: ["site.rebuild_requested"] }];
    newsApi.attach(
      createNewsApiApp({
        db: newsApiDb.db,
        timeZone: TZ,
        eventSecrets: { nrms: SECRET_NRMS_TO_NEWS_API },
        subscribers: newsApiSubscribers,
      }),
    );

    nodToDistribution = distributionClient({
      baseUrl: distribution.url,
      getToken: distributionTokenProvider({ local: { username: "nod", passwordHash: "unused", secret: localAuth.secret } }),
    });
    nod = await listen(
      createNodApp({
        db: nodDb.db,
        auth: nodAuth.bearer,
        loginRouter: nodAuth.loginRouter,
        eventSecrets: { nrms: SECRET_NRMS_TO_NOD },
        render: { siteUrl: publicSite.url, bannerUrl: null },
      }),
    );

    nrms = await listen(
      createNrmsApp({
        db: nrmsDb.db,
        auth: nrmsAuth.bearer,
        loginRouter: nrmsAuth.loginRouter,
        eventSecrets: {},
        workflow: { timeZone: TZ },
      }),
    );
    // NRMS's local copy of Core's ministries/sectors (normally fed by Core's events).
    await seedTaxonomy(nrmsDb.db);
    nrmsSubscribers = [
      { name: "news-api", url: `${newsApi.url}/events`, secret: SECRET_NRMS_TO_NEWS_API, types: ["release.published"] },
      { name: "nod", url: `${nod.url}/events`, secret: SECRET_NRMS_TO_NOD, types: ["release.published"] },
    ];

    // The NRMS editor token: the live owner setup (local admin enabled, one shared secret).
    // ADMIN_ROLES (minted by localLoginRouter) covers NRMS.Editor and NoD.Admin both, so the
    // same token authenticates the admin calls on both apps.
    const tokenRes = await fetch(`${nrms.url}/auth/local/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: localAuth.password }),
    });
    expect(tokenRes.status).toBe(200);
    ({ access_token: editorToken } = (await tokenRes.json()) as { access_token: string });

    // Verified subscriber alex.example@gov.bc.ca on ministries:health, added through NoD's
    // admin API (Phase 2 stands in for the double opt-in journey that arrives in Phase 4).
    const subscriberRes = await fetch(`${nod.url}/api/subscribers`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${editorToken}` },
      body: JSON.stringify({ email: "alex.example@gov.bc.ca", lists: ["ministries:health"] }),
    });
    expect(subscriberRes.status).toBe(201);
  });

  afterAll(async () => {
    // Fix round 1 item 1 (P2-R19): every cleanup step in its own try/catch, so one failing
    // step (e.g. sink.close()) can never skip the ones after it (notably the DB drops) — all
    // errors are collected and the first is rethrown once every step has been attempted.
    const errors: unknown[] = [];
    const step = async (fn: () => unknown): Promise<void> => {
      try {
        await fn();
      } catch (e) {
        errors.push(e);
      }
    };
    await step(() => nrms?.close());
    await step(() => newsApi?.close());
    await step(() => publicSite?.close());
    await step(() => nod?.close());
    await step(() => distribution?.close());
    await step(() => smtpTransport?.close());
    await step(() => sink?.close());
    for (const db of createdDbs) await step(() => db.drop());
    await step(() => (outputDir ? rm(outputDir, { recursive: true, force: true }) : undefined));
    if (errors.length > 0) throw errors[0];
  });

  it("carries a release from NRMS through to a delivered email and a static page", async () => {
    // Step 2: NRMS.Editor creates the release (with an escaping-sensitive headline), approves
    // it (which assigns its Key) and schedules it for immediate release; the test then moves
    // publish_at a minute back to simulate a release that has come due.
    const nrmsPost = async (path: string, body: unknown) => {
      const res = await fetch(`${nrms!.url}/api/releases${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${editorToken}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as { id: string; key: string | null; version: number; status: string } };
    };
    const created = await nrmsPost("", releaseInput);
    expect(created.status).toBe(201);
    const approved = await nrmsPost(`/${created.body.id}/approve`, { version: created.body.version });
    expect(approved.status).toBe(200);
    const key = approved.body.key!;
    expect(key).toMatch(/^\d{4}HLTH\d{4}-\d{6}$/);
    const scheduled = await nrmsPost(`/${created.body.id}/schedule`, { version: approved.body.version, publishAt: "now" });
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.status).toBe("scheduled");
    await nrmsDb.pool.query("UPDATE news_releases SET publish_at = now() - interval '1 minute' WHERE id = $1", [created.body.id]);

    // Step 3: publishDue claims and publishes it, writing release.published to the NRMS
    // outbox; dispatchOnce then delivers it to both News API and NoD (2 subscribers).
    const publishResult = await publishDue({ db: nrmsDb.db, subscribers: nrmsSubscribers });
    expect(publishResult).toEqual({ published: [key], updated: [], unpublished: [], failed: [], deferred: [] });

    const nrmsDispatch = await dispatchOnce({ db: nrmsDb.db, subscribers: nrmsSubscribers });
    expect(nrmsDispatch).toEqual({ delivered: 2, retried: 0, dead: 0 });

    // Step 4: News API's projection applied the release — it's now servable, with the raw
    // (unescaped) headline, since this is data, not rendered HTML.
    const postRes = await fetch(`${newsApi!.url}/api/Posts/${key}?api-version=1.0`);
    expect(postRes.status).toBe(200);
    const post = (await postRes.json()) as { documents: { headline: string | null }[] };
    expect(post.documents[0]?.headline).toBe(HEADLINE);

    // Step 5: News API's dispatcher delivers site.rebuild_requested to the public site,
    // which writes the static pages. The post page must contain the *escaped* headline and
    // never the raw "<weekend>" (fix round 1 item 3) — proves rendering actually escapes.
    const newsApiDispatch = await dispatchOnce({ db: newsApiDb.db, subscribers: newsApiSubscribers });
    expect(newsApiDispatch).toEqual({ delivered: 1, retried: 0, dead: 0 });

    const postHtml = await readFile(join(outputDir!, "releases", key, "index.html"), "utf8");
    expect(postHtml).toContain("Clinics &amp; &lt;weekend&gt; care");
    expect(postHtml).not.toContain("<weekend>");
    // Pin the link format (fix round 1 item 4): the home page's own link is site-relative.
    const homeHtml = await readFile(join(outputDir!, "index.html"), "utf8");
    expect(homeHtml).toContain(`href="/releases/${key}"`);

    // Step 6: NoD's As-It-Happens send job reaches Distribution over real HTTP (NoD's own
    // minted local service token, azp "nod"), and Distribution's sender delivers it to the
    // SMTP sink.
    const nodSend = await sendDueJobs({ db: nodDb.db, distribution: nodToDistribution, links: NOD_LINKS, render: { siteUrl: publicSite!.url, bannerUrl: null } });
    expect(nodSend).toEqual({ sent: 1, retried: 0, failed: 0, cancelled: 0, paused: false });

    const distributionSend = await sendDue({ db: distributionDb.db, transport: smtpTransport!, from: "noreply@example.gov.bc.ca", redirectTo: [] });
    expect(distributionSend).toEqual({ sent: 1, retried: 0, failed: 0, rateLimited: false });

    await vi.waitFor(() => expect(sink!.messages).toHaveLength(1));
    const mail = sink!.messages[0]!;
    const toAddress = mail.to && "value" in mail.to ? mail.to.value[0]?.address : undefined;
    expect(toAddress).toBe("alex.example@gov.bc.ca");
    // The email subject is "BC Gov News - <title>" with the raw headline (a mail header, not
    // rendered HTML) — never escaped.
    expect(mail.subject).toBe(`BC Gov News - ${HEADLINE}`);
    // Task 4: the header carries the real per-recipient one-click unsubscribe URL (substituted
    // by Distribution from the recipient's own `unsubscribeUrl`), not a manage-page link.
    const headerLine = (key: string) => mail.headerLines.find((l) => l.key === key)?.line ?? "";
    expect(headerLine("list-unsubscribe")).toContain(`<${NOD_LINKS.subscribeApiUrl}/OneClickUnsubscribe/`);
    expect(headerLine("list-unsubscribe-post").replace(/\s+/g, " ")).toContain("List-Unsubscribe=One-Click");
    // Pin the link format (fix round 1 item 4): the email's own link is the full absolute URL.
    expect(mail.html).toContain(`${publicSite!.url}/releases/${key}`);

    // Step 7: re-running every worker once more changes nothing — the release is already
    // published, already dispatched, already sent, already delivered.
    const publishAgain = await publishDue({ db: nrmsDb.db, subscribers: nrmsSubscribers });
    expect(publishAgain).toEqual({ published: [], updated: [], unpublished: [], failed: [], deferred: [] });
    const nrmsDispatchAgain = await dispatchOnce({ db: nrmsDb.db, subscribers: nrmsSubscribers });
    expect(nrmsDispatchAgain).toEqual({ delivered: 0, retried: 0, dead: 0 });
    const newsApiDispatchAgain = await dispatchOnce({ db: newsApiDb.db, subscribers: newsApiSubscribers });
    expect(newsApiDispatchAgain).toEqual({ delivered: 0, retried: 0, dead: 0 });
    const nodSendAgain = await sendDueJobs({ db: nodDb.db, distribution: nodToDistribution, links: NOD_LINKS, render: { siteUrl: publicSite!.url, bannerUrl: null } });
    expect(nodSendAgain).toEqual({ sent: 0, retried: 0, failed: 0, cancelled: 0, paused: false });
    const distributionSendAgain = await sendDue({ db: distributionDb.db, transport: smtpTransport!, from: "noreply@example.gov.bc.ca", redirectTo: [] });
    expect(distributionSendAgain).toEqual({ sent: 0, retried: 0, failed: 0, rateLimited: false });

    expect(sink!.messages).toHaveLength(1);
    const inbox = await nodDb.pool.query<{ source: string; type: string; outcome: string }>(
      "SELECT source, type, outcome FROM inbox_events WHERE source = 'nrms' AND type = 'release.published'",
    );
    expect(inbox.rows).toEqual([{ source: "nrms", type: "release.published", outcome: "applied" }]);

    // Fix round 1 item 5 (P2-R19): force a genuine redelivery of the *same* release.published
    // event to NoD — not just re-running dispatchOnce (which found nothing pending above) —
    // by resetting its outbox_deliveries row back to pending. dispatchOnce still reports the
    // HTTP POST as delivered (NoD answers 200), but NoD's own inbox (keyed by event id) must
    // reject it as a duplicate and never re-run the handler: no new delivery/send job, and
    // the sink still has exactly one email.
    await nrmsDb.pool.query("UPDATE outbox_deliveries SET status = 'pending', next_attempt_at = now(), locked_until = NULL WHERE subscriber = 'nod'");
    let redeliveryOutcome: string | undefined;
    const nrmsRedeliver = await dispatchOnce({
      db: nrmsDb.db,
      subscribers: nrmsSubscribers,
      fetchImpl: async (input, init) => {
        const res = await fetch(input, init);
        redeliveryOutcome = await res
          .clone()
          .json()
          .then((body) => (body as { outcome?: string }).outcome)
          .catch(() => undefined);
        return res;
      },
    });
    expect(nrmsRedeliver).toEqual({ delivered: 1, retried: 0, dead: 0 });
    expect(redeliveryOutcome).toBe("duplicate");
    expect(sink!.messages).toHaveLength(1);
    const deliveries = await nodDb.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM deliveries WHERE item_key = $1", [key]);
    expect(deliveries.rows[0]?.count).toBe(1);

    // Step 8: every ID is linked end to end.
    const sendJobs = await nodDb.pool.query<{ item_key: string }>("SELECT item_key FROM send_jobs");
    expect(sendJobs.rows.map((r) => r.item_key)).toEqual([key]);

    const nrmsOutbox = await nrmsDb.pool.query<{ correlation_id: string }>(
      "SELECT envelope->>'correlationId' AS correlation_id FROM outbox_events WHERE type = 'release.published'",
    );
    const newsApiOutbox = await newsApiDb.pool.query<{ correlation_id: string }>(
      "SELECT envelope->>'correlationId' AS correlation_id FROM outbox_events WHERE type = 'site.rebuild_requested'",
    );
    expect(nrmsOutbox.rows).toHaveLength(1);
    expect(newsApiOutbox.rows).toHaveLength(1);
    expect(newsApiOutbox.rows[0]?.correlation_id).toBe(nrmsOutbox.rows[0]?.correlation_id);
  });
});
