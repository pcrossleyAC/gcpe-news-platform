// Playwright global setup (task-6-brief.md): starts the whole stack in-process, the same way
// apps/stack/src/stack.test.ts does for its own tests — fresh test databases, the fake Flickr
// (no FLICKR_API_KEY configured), an in-process SMTP sink standing in for Mailpit, a freshly
// built staff-web bundle, and the four staff test users (editor, site editor, viewer, and the
// environment break-glass Core.Admin). Runs once, in Playwright's main CLI process, before any
// worker starts — the returned function is Playwright's global teardown, run once after every
// test has finished.
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import { hashPassword } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";

import { createCoreTestDb } from "../../apps/core/test/helpers";
import { seedTestUsers } from "../../apps/core/src/services/seed-test-users";
import { createNrmsTestDb, seedTaxonomy } from "../../apps/nrms/test/helpers";
import { pageTypes } from "../../apps/nrms/src/db/schema";
import { LANG_EN } from "@gcpe/nrms-contract";
import { createNewsTestDb } from "../../apps/news-api/test/helpers";
import { createPublicSiteTestDb } from "../../apps/public-site/test/helpers";
import { createNodTestDb } from "../../apps/nod/test/helpers";
import { createDistributionTestDb } from "../../apps/distribution/test/helpers";
import { startSmtpSink } from "../../apps/distribution/test/smtp-sink";
import { startStack } from "../../apps/stack/src/stack";
import { runBuild } from "../../scripts/build-staff-web.mjs";
import { TEST_USER_PASSWORDS, TICK_TOKEN, ADMIN_PASSWORD } from "./constants";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const LOCAL_AUTH_SECRET = "e2e-local-auth-secret-32-characters-long!";
const STACK_EVENT_SECRET = `e2e-event-secret-${"s".repeat(32)}`;
const MANAGE_URL = "http://nod.invalid/manage";

async function probeFreePort(): Promise<number> {
  return new Promise((res, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => res(port));
    });
  });
}

async function listenOnPort(app: Express, port: number): Promise<{ close(): Promise<void> }> {
  const server: Server = createServer(app);
  await new Promise<void>((res, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => res());
  });
  return {
    close: () =>
      new Promise<void>((res) => {
        server.closeAllConnections();
        server.close(() => res());
      }),
  };
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  console.log("[e2e global-setup] building staff-web…");
  await runBuild();
  const staffWebDir = join(repoRoot, "apps/staff-web/dist");

  console.log("[e2e global-setup] creating test databases…");
  const [core, nrms, newsApi, publicSite, nod, distribution] = await Promise.all([
    createCoreTestDb(),
    createNrmsTestDb(),
    createNewsTestDb(),
    createPublicSiteTestDb(),
    createNodTestDb(),
    createDistributionTestDb(),
  ]);
  const dbs: Record<string, TestDatabase> = { core, nrms, newsApi, publicSite, nod, distribution };

  console.log("[e2e global-setup] seeding NRMS taxonomy and staff test users…");
  await seedTaxonomy(nrms.db);
  await seedTestUsers(core.db, TEST_USER_PASSWORDS);

  // NewReleaseScreen's "Page title" is a <select> populated from GET /page-types — there's no
  // write endpoint for this table (it's only ever populated by the legacy importer in
  // production), so the form is unusable without at least one row per creatable type. Legacy
  // page-title wording, English only (LANG_EN) — the suite never needs French page titles.
  await nrms.db.insert(pageTypes).values([
    { pageTitle: "News Release", languageId: LANG_EN, releaseType: "release", sortOrder: 0, layout: "formal" },
    { pageTitle: "News Story", languageId: LANG_EN, releaseType: "story", sortOrder: 0, layout: "formal" },
    { pageTitle: "Fact Sheet", languageId: LANG_EN, releaseType: "factsheet", sortOrder: 0, layout: "formal" },
    { pageTitle: "Media Advisory", languageId: LANG_EN, releaseType: "advisory", sortOrder: 0, layout: "formal" },
  ]);

  const outputDir = await mkdtemp(join(tmpdir(), "gcpe-e2e-site-"));
  const dataDir = await mkdtemp(join(tmpdir(), "gcpe-e2e-data-"));
  const sink = await startSmtpSink();

  // The SMTP sink's `messages` array only lives in *this* (the main CLI) process's memory —
  // Playwright's test workers are separate forked processes, so item 5/14's "email arrives"
  // assertions need an HTTP window into it. A tiny inspector server, queried by
  // support.ts's `fetchSentMessages`.
  const mailInspector = createServer((req, res) => {
    if (req.url === "/messages") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          sink.messages.map((m) => ({
            subject: m.subject ?? null,
            to: m.to && "value" in m.to ? m.to.value.map((v) => v.address).filter((a): a is string => !!a) : [],
            text: m.text ?? null,
            attachmentNames: (m.attachments ?? []).map((a) => a.filename ?? ""),
          })),
        ),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((res) => mailInspector.listen(0, "127.0.0.1", res));
  const mailInspectorPort = (mailInspector.address() as AddressInfo).port;

  const port = await probeFreePort();
  const passwordHash = await hashPassword(ADMIN_PASSWORD);

  const env: NodeJS.ProcessEnv = {
    PORT: String(port),
    TICK_TOKEN,
    STACK_LOOPS: "false",
    UPDATES_HUB_ENABLED: "false",
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    LOCAL_ADMIN_ENABLED: "true",
    LOCAL_ADMIN_PASSWORD_HASH: passwordHash,
    LOCAL_AUTH_SECRET,
    STACK_EVENT_SECRET,
    STAFF_WEB_DIR: staffWebDir,

    CORE_DATABASE_URL: core.url,
    NRMS_DATABASE_URL: nrms.url,
    NEWSAPI_DATABASE_URL: newsApi.url,

    SITE_DATABASE_URL: publicSite.url,
    SITE_NEWS_API_URL: "self:/",
    SITE_OUTPUT_DIR: outputDir,
    SITE_PUBLIC_SITE_URL: "self:/site",

    NOD_DATABASE_URL: nod.url,
    NOD_DISTRIBUTION_URL: "self:/distribution",
    NOD_PUBLIC_SITE_URL: "self:/site",
    NOD_MANAGE_URL: MANAGE_URL,

    DIST_DATABASE_URL: distribution.url,
    DIST_SMTP_HOST: "127.0.0.1",
    DIST_SMTP_PORT: String(sink.port),
    DIST_SMTP_SECURE: "false",
    DIST_MAIL_FROM: "noreply@example.gov.bc.ca",
    DIST_MAIL_ALLOW_REAL_RECIPIENTS: "true",
  };

  console.log("[e2e global-setup] starting the stack…");
  const handle = await startStack(env);
  if (handle.port !== port) throw new Error(`expected startStack to keep the requested port ${port}, got ${handle.port}`);
  const bound = await listenOnPort(handle.app, handle.port);
  const baseUrl = `http://127.0.0.1:${handle.port}`;

  // Playwright's worker processes are forked from this (the main CLI) process only after
  // globalSetup returns, so they inherit this mutation of process.env.
  process.env.E2E_BASE_URL = baseUrl;
  process.env.E2E_MAIL_INSPECT_URL = `http://127.0.0.1:${mailInspectorPort}/messages`;
  // Item 9 (Flickr outage) needs to fast-forward past the Flickr job's 2-minute real-time grace
  // period without actually sleeping two minutes — support.ts's `nrmsDb()` opens its own
  // connection to this same test database from the worker process to do that.
  process.env.E2E_NRMS_DATABASE_URL = nrms.url;
  console.log(`[e2e global-setup] stack ready at ${baseUrl}`);

  return async function globalTeardown(): Promise<void> {
    console.log("[e2e global-teardown] shutting down the stack…");
    const errors: unknown[] = [];
    const step = async (fn: () => unknown): Promise<void> => {
      try {
        await fn();
      } catch (e) {
        errors.push(e);
      }
    };
    await Promise.all(handle.closeBeforeServer.map((c) => step(() => c.close())));
    await step(() => bound.close());
    await Promise.all(handle.closers.map((c) => step(() => c.close())));
    await step(() => sink.close());
    await step(
      () =>
        new Promise<void>((res) => {
          mailInspector.closeAllConnections();
          mailInspector.close(() => res());
        }),
    );
    for (const db of Object.values(dbs)) await step(() => db.drop());
    await step(() => rm(outputDir, { recursive: true, force: true }));
    await step(() => rm(dataDir, { recursive: true, force: true }));
    if (errors.length > 0) {
      console.error("[e2e global-teardown] errors while shutting down:", errors);
    }
  };
}
