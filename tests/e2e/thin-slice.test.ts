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
import { localLoginRouter } from "@gcpe/auth";
import { dispatchOnce, type SubscriberConfig } from "@gcpe/events";

import { createApp as createNrmsApp } from "../../apps/nrms/src/app";
import { publishDue } from "../../apps/nrms/src/publisher";
import { createNrmsTestDb, sampleDraft } from "../../apps/nrms/test/helpers";

import { createApp as createNewsApiApp } from "../../apps/news-api/src/app";
import { createNewsTestDb } from "../../apps/news-api/test/helpers";

import { createApp as createPublicSiteApp } from "../../apps/public-site/src/app";
import { escapeHtml } from "../../apps/public-site/src/render";
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
// as a string in the As-It-Happens email, whose {{manageUrl}} substitution the test asserts
// the shape of (?token=...).
const MANAGE_URL = "http://nod.invalid/manage";

// Signing secrets between each pair of apps (sender's `subscribers[].secret` must equal the
// receiver's `eventSecrets[source]`) — distinct per pair so a misrouted signature would be
// caught, same house style as every app's own test/helpers.ts EVENT_SECRETS.
const SECRET_NRMS_TO_NEWS_API = "e2e-nrms-to-news-api-secret";
const SECRET_NRMS_TO_NOD = "e2e-nrms-to-nod-secret";
const SECRET_NEWS_API_TO_PUBLIC_SITE = "e2e-news-api-to-public-site-secret";

const TZ = "America/Vancouver";

describe("Phase 2 exit check: NRMS release -> publish -> News API -> static page -> NoD -> Distribution -> email", () => {
  let nrmsDb: TestDatabase;
  let newsApiDb: TestDatabase;
  let publicSiteDb: TestDatabase;
  let nodDb: TestDatabase;
  let distributionDb: TestDatabase;

  let nrms: Listening;
  let newsApi: Awaited<ReturnType<typeof reserve>>;
  let publicSite: Awaited<ReturnType<typeof reserve>>;
  let nod: Listening;
  let distribution: Listening;

  let outputDir: string;
  let sink: Awaited<ReturnType<typeof startSmtpSink>>;
  let smtpTransport: Transporter;
  let nodToDistribution: DistributionClient;

  let editorToken: string;
  let nrmsSubscribers: SubscriberConfig[];
  let newsApiSubscribers: SubscriberConfig[];

  const headline = sampleDraft.documents[0]!.headline!;
  // Clock skew between the test DBs and this process can be < 1ms; every publishDue/
  // dispatchOnce/sendDueJobs/sendDue call below passes a `now` slightly in the future so a
  // row scheduled "now" is never missed as not-yet-due.
  const slightlyAhead = () => new Date(Date.now() + 1000);

  beforeAll(async () => {
    [nrmsDb, newsApiDb, publicSiteDb, nodDb, distributionDb] = await Promise.all([
      createNrmsTestDb(),
      createNewsTestDb(),
      createPublicSiteTestDb(),
      createNodTestDb(),
      createDistributionTestDb(),
    ]);

    outputDir = await mkdtemp(join(tmpdir(), "gcpe-e2e-public-site-"));
    sink = await startSmtpSink();
    smtpTransport = nodemailer.createTransport({
      host: "127.0.0.1",
      port: sink.port,
      secure: false,
      ignoreTLS: true,
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 5_000,
    });

    const auth = await localAuthEnv();

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
        auth: { local: { secret: auth.secret } },
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
      getToken: distributionTokenProvider({ local: { username: "nod", passwordHash: "unused", secret: auth.secret } }),
    });
    nod = await listen(
      createNodApp({
        db: nodDb.db,
        auth: { local: { secret: auth.secret } },
        eventSecrets: { nrms: SECRET_NRMS_TO_NOD },
        handlerOptions: { publicSiteUrl: publicSite.url, manageUrl: MANAGE_URL },
      }),
    );

    nrms = await listen(
      createNrmsApp({
        db: nrmsDb.db,
        auth: { local: { secret: auth.secret } },
        loginRouter: localLoginRouter({ username: "admin", passwordHash: auth.passwordHash, secret: auth.secret }),
      }),
    );
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
      body: JSON.stringify({ username: "admin", password: auth.password }),
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
    await Promise.all([nrms?.close(), newsApi?.close(), publicSite?.close(), nod?.close(), distribution?.close()]);
    smtpTransport?.close();
    await sink?.close();
    await Promise.all([nrmsDb?.drop(), newsApiDb?.drop(), publicSiteDb?.drop(), nodDb?.drop(), distributionDb?.drop()]);
    if (outputDir) await rm(outputDir, { recursive: true, force: true });
  });

  it("carries a release from NRMS through to a delivered email and a static page", async () => {
    // Step 2: NRMS.Editor creates the release from sampleDraft, then schedules it a minute
    // in the past.
    const createRes = await fetch(`${nrms.url}/api/releases`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${editorToken}` },
      body: JSON.stringify(sampleDraft),
    });
    expect(createRes.status).toBe(201);

    const publishAt = new Date(Date.now() - 60_000).toISOString();
    const scheduleRes = await fetch(`${nrms.url}/api/releases/${sampleDraft.key}/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${editorToken}` },
      body: JSON.stringify({ publishAt }),
    });
    expect(scheduleRes.status).toBe(200);

    // Step 3: publishDue claims and publishes it, writing release.published to the NRMS
    // outbox; dispatchOnce then delivers it to both News API and NoD (2 subscribers).
    const publishResult = await publishDue({ db: nrmsDb.db, subscribers: nrmsSubscribers, now: slightlyAhead });
    expect(publishResult).toEqual({ published: [sampleDraft.key], failed: [] });

    const nrmsDispatch = await dispatchOnce({ db: nrmsDb.db, subscribers: nrmsSubscribers });
    expect(nrmsDispatch).toEqual({ delivered: 2, retried: 0, dead: 0 });

    // Step 4: News API's projection applied the release — it's now servable.
    const postRes = await fetch(`${newsApi.url}/api/Posts/${sampleDraft.key}?api-version=1.0`);
    expect(postRes.status).toBe(200);
    const post = (await postRes.json()) as { documents: { headline: string | null }[] };
    expect(post.documents[0]?.headline).toBe(headline);

    // Step 5: News API's dispatcher delivers site.rebuild_requested to the public site,
    // which writes the static pages.
    const newsApiDispatch = await dispatchOnce({ db: newsApiDb.db, subscribers: newsApiSubscribers });
    expect(newsApiDispatch).toEqual({ delivered: 1, retried: 0, dead: 0 });

    const postHtml = await readFile(join(outputDir, "releases", sampleDraft.key, "index.html"), "utf8");
    expect(postHtml).toContain(escapeHtml(headline));
    const homeHtml = await readFile(join(outputDir, "index.html"), "utf8");
    expect(homeHtml).toContain(`/releases/${sampleDraft.key}`);

    // Step 6: NoD's As-It-Happens send job reaches Distribution over real HTTP (NoD's own
    // minted local service token, azp "nod"), and Distribution's sender delivers it to the
    // SMTP sink.
    const nodSend = await sendDueJobs({ db: nodDb.db, distribution: nodToDistribution, manageUrl: MANAGE_URL, now: slightlyAhead });
    expect(nodSend).toEqual({ sent: 1, retried: 0, failed: 0 });

    const distributionSend = await sendDue({ db: distributionDb.db, transport: smtpTransport, from: "noreply@example.gov.bc.ca", redirectTo: [], now: slightlyAhead });
    expect(distributionSend).toEqual({ sent: 1, retried: 0, failed: 0 });

    await vi.waitFor(() => expect(sink.messages).toHaveLength(1));
    const mail = sink.messages[0]!;
    const toAddress = mail.to && "value" in mail.to ? mail.to.value[0]?.address : undefined;
    expect(toAddress).toBe("alex.example@gov.bc.ca");
    expect(mail.subject).toBe(headline);
    const headerLine = (key: string) => mail.headerLines.find((l) => l.key === key)?.line ?? "";
    expect(headerLine("list-unsubscribe")).toContain("?token=");
    expect(headerLine("list-unsubscribe-post").replace(/\s+/g, " ")).toContain("List-Unsubscribe=One-Click");
    expect(mail.html).toContain(`/releases/${sampleDraft.key}`);

    // Step 7: re-running every worker once more changes nothing — the release is already
    // published, already dispatched, already sent, already delivered.
    const publishAgain = await publishDue({ db: nrmsDb.db, subscribers: nrmsSubscribers, now: slightlyAhead });
    expect(publishAgain).toEqual({ published: [], failed: [] });
    const nrmsDispatchAgain = await dispatchOnce({ db: nrmsDb.db, subscribers: nrmsSubscribers });
    expect(nrmsDispatchAgain).toEqual({ delivered: 0, retried: 0, dead: 0 });
    const newsApiDispatchAgain = await dispatchOnce({ db: newsApiDb.db, subscribers: newsApiSubscribers });
    expect(newsApiDispatchAgain).toEqual({ delivered: 0, retried: 0, dead: 0 });
    const nodSendAgain = await sendDueJobs({ db: nodDb.db, distribution: nodToDistribution, manageUrl: MANAGE_URL, now: slightlyAhead });
    expect(nodSendAgain).toEqual({ sent: 0, retried: 0, failed: 0 });
    const distributionSendAgain = await sendDue({ db: distributionDb.db, transport: smtpTransport, from: "noreply@example.gov.bc.ca", redirectTo: [], now: slightlyAhead });
    expect(distributionSendAgain).toEqual({ sent: 0, retried: 0, failed: 0 });

    expect(sink.messages).toHaveLength(1);
    const inbox = await nodDb.pool.query<{ source: string; type: string; outcome: string }>(
      "SELECT source, type, outcome FROM inbox_events WHERE source = 'nrms' AND type = 'release.published'",
    );
    expect(inbox.rows).toEqual([{ source: "nrms", type: "release.published", outcome: "applied" }]);

    // Step 8: every ID is linked end to end.
    const sendJobs = await nodDb.pool.query<{ release_key: string }>("SELECT release_key FROM send_jobs");
    expect(sendJobs.rows.map((r) => r.release_key)).toEqual([sampleDraft.key]);

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
