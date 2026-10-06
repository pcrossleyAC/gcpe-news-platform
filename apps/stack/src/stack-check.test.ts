// Tests for checkStack(), the logic behind `node stack.js --check` (Task 15): validates every
// app's own env schema, its auth config (P2-R34), each app's resolved MIGRATIONS_FOLDER
// actually existing on disk, and the tenant config (incl. the P2-R17 time-zone self-check) —
// all WITHOUT opening a database connection. This is deliberately a separate, DB-free test
// file from stack.test.ts: every case here must run instantly with no Postgres fixture.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkStack } from "./stack";

const TICK_TOKEN = "t".repeat(32);
const LOCAL_AUTH_SECRET = "s".repeat(32);
// A real, policy-valid hashPassword() output (scrypt$16384$8$1$<16+ byte salt>$<32+ byte key>,
// base64url) — fixed here rather than computed so this file stays synchronous/fast; nothing
// below ever verifies a password against it, only that authFromEnv accepts its *shape*.
const VALID_PASSWORD_HASH = "scrypt$16384$8$1$AR0_F516SFjYwNcFNR980A$DE642bMgMzH2Q46b7hoQ2hf-CTYQIrqFSaM7xJNdHjGnXQw-T7aYQgf5Fqghm7p5YL4CEuW_ipSpedzYPPHzIw";

// Syntactically valid (passes z.string().url()) but never actually dialled — port 1 on
// loopback refuses instantly if anything *did* try to connect, which the "fast" test below
// uses to prove checkStack never does.
const DB = (name: string) => `postgres://user:pass@127.0.0.1:1/${name}`;

const coreMigrations = fileURLToPath(new URL("../../core/migrations", import.meta.url));

function baseEnv(): NodeJS.ProcessEnv {
  return {
    TICK_TOKEN,
    // Shared (apps/stack/src/env.ts's isSharedKey) — every app's view inherits these, same as
    // a real deploy where LOCAL_ADMIN_* and LOCAL_AUTH_SECRET are set once, not per-prefix.
    LOCAL_ADMIN_ENABLED: "true",
    LOCAL_ADMIN_PASSWORD_HASH: VALID_PASSWORD_HASH,
    LOCAL_AUTH_SECRET,
    CORE_DATABASE_URL: DB("core"),
    CORE_EVENT_SUBSCRIBERS: JSON.stringify([{ name: "news-api", url: "self:/events", secret: "s", types: ["org.upserted"] }]),

    NRMS_DATABASE_URL: DB("nrms"),
    NRMS_EVENT_SUBSCRIBERS: JSON.stringify([
      { name: "news-api", url: "self:/events", secret: "s", types: ["release.published"] },
      { name: "nod", url: "self:/nod/events", secret: "s", types: ["release.published"] },
    ]),

    NEWSAPI_DATABASE_URL: DB("news_api"),
    NEWSAPI_EVENT_SECRETS: JSON.stringify({ nrms: "s", core: "s" }),
    NEWSAPI_EVENT_SUBSCRIBERS: JSON.stringify([{ name: "public-site", url: "self:/site-builder/events", secret: "s", types: ["site.rebuild_requested"] }]),

    SITE_DATABASE_URL: DB("site"),
    SITE_NEWS_API_URL: "self:/",
    SITE_OUTPUT_DIR: "./site-output",
    SITE_EVENT_SECRETS: JSON.stringify({ "news-api": "s" }),
    SITE_PUBLIC_SITE_URL: "https://news.example.invalid/site",

    NOD_DATABASE_URL: DB("nod"),
    NOD_EVENT_SECRETS: JSON.stringify({ nrms: "s" }),
    NOD_DISTRIBUTION_URL: "self:/distribution",
    NOD_PUBLIC_SITE_URL: "https://news.example.invalid/site",
    NOD_LINK_SECRET: "l".repeat(32),

    DIST_DATABASE_URL: DB("distribution"),
    DIST_SMTP_HOST: "127.0.0.1",
    DIST_MAIL_FROM: "noreply@news.example.invalid",
    DIST_MAIL_REDIRECT_TO: "ops@news.example.invalid",
  };
}

describe("checkStack", () => {
  it("reports ok:true for every app when the env is valid and migrations folders exist", async () => {
    const result = await checkStack(baseEnv());
    expect(result.ok).toBe(true);
    for (const label of ["core", "nrms", "news-api", "public-site", "nod", "distribution"]) {
      expect.soft(result.apps[label]?.ok, label).toBe(true);
    }
    expect(result.tenantId).toBe("bc");
  });

  it("never attempts a database connection — resolves fast even with an unreachable DATABASE_URL", async () => {
    const start = Date.now();
    const result = await checkStack(baseEnv());
    const elapsedMs = Date.now() - start;
    expect(result.ok).toBe(true);
    // Any real connection attempt to 127.0.0.1:1 would either hang or take noticeably longer
    // than pure schema/filesystem checks; this is generous but still discriminates against an
    // accidental createDb()/runMigrations() call.
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("names the app and its env prefix when a required var is missing for that app", async () => {
    const env = baseEnv();
    delete env.NOD_DISTRIBUTION_URL;
    const result = await checkStack(env);
    expect(result.ok).toBe(false);
    expect(result.apps.nod?.ok).toBe(false);
    expect(result.apps.nod?.error).toMatch(/NOD_\*/);
    expect(result.apps.nod?.error).toMatch(/DISTRIBUTION_URL/);
    // Every other app is unaffected by nod's own missing var.
    expect(result.apps.core?.ok).toBe(true);
  });

  it("reports ok:false (naming the path) when a resolved MIGRATIONS_FOLDER doesn't exist on disk", async () => {
    const env = baseEnv();
    env.CORE_MIGRATIONS_FOLDER = "/nonexistent/path/does-not-exist";
    const result = await checkStack(env);
    expect(result.ok).toBe(false);
    expect(result.apps.core?.ok).toBe(false);
    expect(result.apps.core?.migrationsFolder).toBe("/nonexistent/path/does-not-exist");
    expect(result.apps.core?.error).toMatch(/migrations folder not found/);
  });

  it("accepts an explicit, existing MIGRATIONS_FOLDER override", async () => {
    const env = baseEnv();
    env.CORE_MIGRATIONS_FOLDER = coreMigrations;
    const result = await checkStack(env);
    expect(result.apps.core).toEqual({ ok: true, migrationsFolder: coreMigrations });
  });

  // Ruling P2-R34: --check must exercise the exact same authFromEnv() every app's real
  // startup runs — a truncated LOCAL_ADMIN_PASSWORD_HASH previously passed --check cleanly
  // (the app's own env schema has no auth fields at all) and only failed three steps later,
  // at an actual startStack(), with no app/prefix named.
  it("fails a truncated LOCAL_ADMIN_PASSWORD_HASH for every app, naming the app and prefix", async () => {
    const env = baseEnv();
    env.LOCAL_ADMIN_PASSWORD_HASH = VALID_PASSWORD_HASH.slice(0, 40); // cuts off mid-hash
    const result = await checkStack(env);
    expect(result.ok).toBe(false);
    for (const [label, prefix] of [
      ["core", "CORE"],
      ["nrms", "NRMS"],
      ["news-api", "NEWSAPI"],
      ["public-site", "SITE"],
      ["nod", "NOD"],
      ["distribution", "DIST"],
    ] as const) {
      expect.soft(result.apps[label]?.ok, label).toBe(false);
      expect.soft(result.apps[label]?.error, label).toMatch(new RegExp(`${prefix}_\\*`));
      expect.soft(result.apps[label]?.error, label).toMatch(/LOCAL_ADMIN_PASSWORD_HASH/);
    }
  });

  it("fails a LOCAL_AUTH_SECRET shorter than 32 characters", async () => {
    const env = baseEnv();
    env.LOCAL_AUTH_SECRET = "too-short";
    const result = await checkStack(env);
    expect(result.ok).toBe(false);
    expect(result.apps.core?.error).toMatch(/LOCAL_AUTH_SECRET/);
  });

  it("fails a half-set Entra pair (ENTRA_TENANT_ID without AUTH_AUDIENCE)", async () => {
    const env = baseEnv();
    delete env.LOCAL_ADMIN_ENABLED;
    delete env.LOCAL_ADMIN_PASSWORD_HASH;
    env.ENTRA_TENANT_ID = "some-tenant-id";
    // CORE_AUTH_AUDIENCE deliberately left unset.
    const result = await checkStack(env);
    expect(result.ok).toBe(false);
    expect(result.apps.core?.error).toMatch(/ENTRA_TENANT_ID.*AUTH_AUDIENCE|AUTH_AUDIENCE.*ENTRA_TENANT_ID/);
  });

  it("fails LOCAL_ADMIN_ENABLED=true under NODE_ENV=production without the explicit override", async () => {
    const env = baseEnv();
    env.NODE_ENV = "production";
    const result = await checkStack(env);
    expect(result.ok).toBe(false);
    expect(result.apps.core?.error).toMatch(/production/i);
  });

  it("passes LOCAL_ADMIN_ENABLED=true under NODE_ENV=production once LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true is set", async () => {
    const env = baseEnv();
    env.NODE_ENV = "production";
    env.LOCAL_ADMIN_ALLOW_IN_PRODUCTION = "true";
    const result = await checkStack(env);
    expect(result.ok).toBe(true);
  });
});
