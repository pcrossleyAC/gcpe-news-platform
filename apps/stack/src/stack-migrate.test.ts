// Tests for migrateStack(), the logic behind `node stack.js --migrate`: applies every configured
// app's migrations to its database and exits, without starting any app — so an orchestrator
// (an OpenShift Job or initContainer, docs/deploy/openshift.md) can migrate before a rollout
// with the same image and the same env as the Deployment. startStack still migrates on start;
// both go through db-kit's advisory-locked runMigrations, so running both is harmless.
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminUrl, queryOnce, withAdmin } from "@gcpe/db-kit";
import { migrateStack } from "./stack";

const APPS = [
  { label: "core", prefix: "CORE", dir: "core" },
  { label: "nrms", prefix: "NRMS", dir: "nrms" },
  { label: "nod", prefix: "NOD", dir: "nod" },
  { label: "calendar", prefix: "CALENDAR", dir: "calendar" },
  { label: "distribution", prefix: "DIST", dir: "distribution" },
  { label: "public-site", prefix: "SITE", dir: "public-site" },
  { label: "news-api", prefix: "NEWSAPI", dir: "news-api" },
] as const;

const journalLength = (dir: string): number =>
  (JSON.parse(readFileSync(fileURLToPath(new URL(`../../${dir}/migrations/meta/_journal.json`, import.meta.url)), "utf8")) as { entries: unknown[] }).entries.length;

const created: string[] = [];
async function emptyDatabase(): Promise<string> {
  const name = `test_migrate_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await withAdmin((c) => c.query(`CREATE DATABASE "${name}"`));
  created.push(name);
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

async function appliedMigrations(url: string): Promise<number> {
  const rows = await queryOnce<{ n: string }>(url, "SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations", []);
  return Number(rows[0]!.n);
}

const VALID_PASSWORD_HASH = "scrypt$16384$8$1$AR0_F516SFjYwNcFNR980A$DE642bMgMzH2Q46b7hoQ2hf-CTYQIrqFSaM7xJNdHjGnXQw-T7aYQgf5Fqghm7p5YL4CEuW_ipSpedzYPPHzIw";

let urls: Record<string, string>;
let dataDir: string;

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATA_DIR: dataDir,
    TICK_TOKEN: "t".repeat(32),
    LOCAL_ADMIN_ENABLED: "true",
    LOCAL_ADMIN_PASSWORD_HASH: VALID_PASSWORD_HASH,
    LOCAL_AUTH_SECRET: "s".repeat(32),
    STACK_EVENT_SECRET: "e".repeat(32),
    SITE_NEWS_API_URL: "self:/",
    SITE_OUTPUT_DIR: "./site-output",
    SITE_PUBLIC_SITE_URL: "https://news.example.invalid",
    NOD_DISTRIBUTION_URL: "self:/distribution",
    NOD_PUBLIC_SITE_URL: "https://news.example.invalid",
    NOD_LINK_SECRET: "l".repeat(32),
    DIST_SMTP_HOST: "127.0.0.1",
    DIST_MAIL_FROM: "noreply@news.example.invalid",
    DIST_MAIL_REDIRECT_TO: "ops@news.example.invalid",
    ...Object.fromEntries(APPS.map((a) => [`${a.prefix}_DATABASE_URL`, urls[a.label]!])),
    ...overrides,
  };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "gcpe-stack-migrate-"));
  urls = {};
  for (const a of APPS) urls[a.label] = await emptyDatabase();
});

afterAll(async () => {
  for (const name of created) await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
});

describe("migrateStack", () => {
  it("applies every app's full migration journal to its own empty database, and running it again is a no-op", async () => {
    const first = await migrateStack(env());
    expect(first.ok).toBe(true);
    for (const a of APPS) {
      expect.soft(first.apps[a.label]?.ok, a.label).toBe(true);
      expect.soft(await appliedMigrations(urls[a.label]!), a.label).toBe(journalLength(a.dir));
    }

    const second = await migrateStack(env());
    expect(second.ok).toBe(true);
    for (const a of APPS) expect.soft(await appliedMigrations(urls[a.label]!), a.label).toBe(journalLength(a.dir));
  });

  it("skips the Calendar when CALENDAR_DATABASE_URL is not set, as startStack does", async () => {
    const result = await migrateStack(env({ CALENDAR_DATABASE_URL: undefined }));
    expect(result.ok).toBe(true);
    expect(result.apps.calendar).toEqual({ ok: true, skipped: "CALENDAR_DATABASE_URL is not set" });
  });

  it("fails naming the app and its prefix when one database is unreachable, and still migrates the others", async () => {
    const result = await migrateStack(env({ NOD_DATABASE_URL: "postgres://user:pass@127.0.0.1:1/nod" }));
    expect(result.ok).toBe(false);
    expect(result.apps.nod?.ok).toBe(false);
    expect(result.apps.nod?.error).toMatch(/NOD_\*/);
    expect(result.apps.core?.ok).toBe(true);
    expect(result.apps["news-api"]?.ok).toBe(true);
  });

  it("fails naming the app when its env does not parse, without touching any database", async () => {
    const result = await migrateStack(env({ DIST_SMTP_HOST: undefined }));
    expect(result.ok).toBe(false);
    expect(result.apps.distribution?.ok).toBe(false);
    expect(result.apps.distribution?.error).toMatch(/DIST_\*/);
    expect(result.apps.distribution?.error).toMatch(/SMTP_HOST/);
  });
});
