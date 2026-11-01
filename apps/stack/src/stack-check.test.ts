// Tests for checkStack(), the logic behind `node stack.js --check` (Task 15): validates every
// app's own env schema, its auth config (P2-R34), each app's resolved MIGRATIONS_FOLDER
// actually existing on disk, and the tenant config (incl. the P2-R17 time-zone self-check) —
// all WITHOUT opening an app's database (the one exception, the Calendar's read-only time-zone
// probe, is a warning field and is tested at the end). This is deliberately a separate, DB-free
// test file from stack.test.ts: every case here must run instantly with no Postgres fixture.
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { checkStack, startStack } from "./stack";

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

  it("fails Core when Entra sign-in is partly configured, naming the missing settings", async () => {
    const result = await checkStack({ ...baseEnv(), CORE_ENTRA_CLIENT_ID: "core-client" });
    expect(result.ok).toBe(false);
    expect(result.apps.core?.ok).toBe(false);
    expect(result.apps.core?.error).toContain("(its variables are CORE_*)");
    expect(result.apps.core?.error).toContain("Entra sign-in is partly configured: missing ENTRA_TENANT_ID, ENTRA_CLIENT_SECRET, PUBLIC_BASE_URL, SESSION_SECRET");
    expect(result.apps.nrms?.ok).toBe(true);
  });

  it("passes Core with Entra sign-in fully configured", async () => {
    const result = await checkStack({
      ...baseEnv(),
      ENTRA_TENANT_ID: "0000fa4e-0000-4000-8000-000000000004",
      SESSION_SECRET: "s".repeat(32),
      CORE_AUTH_AUDIENCE: "api://core.example.test",
      CORE_ENTRA_CLIENT_ID: "core-client",
      CORE_ENTRA_CLIENT_SECRET: "core-secret",
      CORE_PUBLIC_BASE_URL: "https://news.example.test",
    });
    expect(result.apps.core).toEqual({ ok: true, migrationsFolder: expect.any(String) });
  });

  it("reports a refused FAKE_ENTRA_ENABLED as Core's own result, instead of throwing", async () => {
    const env = baseEnv();
    env.NODE_ENV = "production";
    env.FAKE_ENTRA_ENABLED = "true";
    // usesFakeEntra throws on a real production deployment (apps/stack/src/env.ts) before Core's
    // own env schema or auth checks run — the per-app loop must catch that, not propagate it.
    const result = await checkStack(env);
    expect(result.ok).toBe(false);
    expect(result.apps.core?.ok).toBe(false);
    expect(result.apps.core?.error).toContain("(its variables are CORE_*)");
    expect(result.apps.core?.error).toContain("FAKE_ENTRA_ENABLED is refused on a production deployment");
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
    // A test site in production mode (boxs.ca's shape): break-glass alone no longer makes one
    // (2026-10-31), and real production has its own checks (the "real production" block below).
    env.SITE_ENVIRONMENT = "test";
    const result = await checkStack(env);
    expect(result.ok).toBe(true);
  });

  it("checks the Calendar when CALENDAR_DATABASE_URL is set, and reports it skipped when not", async () => {
    const withCal = await checkStack({ ...baseEnv(), CALENDAR_DATABASE_URL: DB("calendar") });
    expect(withCal.apps.calendar).toMatchObject({ ok: true });
    const without = await checkStack(baseEnv());
    expect(without.apps.calendar).toEqual({ ok: true, skipped: "CALENDAR_DATABASE_URL is not set" });
  });

  it("reports the Calendar database's time-zone check as a warning field that never fails the check", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Port 1 refuses at once: the probe reports unreachable, and the check still passes.
      const withCal = await checkStack({ ...baseEnv(), CALENDAR_DATABASE_URL: DB("calendar") });
      expect(withCal.ok).toBe(true);
      expect(withCal.calendarDbTimeZone).toBe("unreachable");
      expect(errors.mock.calls.map((c) => c.map(String).join(" ")).join("\n")).not.toContain("pass@");
      const without = await checkStack(baseEnv());
      expect(without.calendarDbTimeZone).toBeUndefined();
    } finally {
      errors.mockRestore();
    }
  });

  it("fails the Calendar when CALENDAR_STORAGE_DIR is inside NRMS's public files", async () => {
    const result = await checkStack({ ...baseEnv(), CALENDAR_DATABASE_URL: DB("calendar"), DATA_DIR: "/tmp/gcpe-check-data", CALENDAR_STORAGE_DIR: "/tmp/gcpe-check-data/storage/calendar" });
    expect(result.ok).toBe(false);
    expect(result.apps.calendar?.ok).toBe(false);
    expect(result.apps.calendar?.error).toContain("must not be inside, equal to or contain");
  });

  it("fails the News API when NEWSAPI_EMBEDDINGS_PROVIDER=stand-in on a real production deployment", async () => {
    const env = baseEnv();
    env.NODE_ENV = "production";
    env.NEWSAPI_EMBEDDINGS_PROVIDER = "stand-in";
    const result = await checkStack(env);
    expect(result.ok).toBe(false);
    expect(result.apps["news-api"]?.error).toMatch(/NEWSAPI_\*/);
    expect(result.apps["news-api"]?.error).toMatch(/EMBEDDINGS_PROVIDER: stand-in is refused/);
  });

  it("passes NEWSAPI_EMBEDDINGS_PROVIDER=stand-in on a production-mode test deployment (boxs.ca)", async () => {
    const env = baseEnv();
    env.NODE_ENV = "production";
    env.LOCAL_ADMIN_ALLOW_IN_PRODUCTION = "true";
    env.SITE_ENVIRONMENT = "test";
    env.NEWSAPI_EMBEDDINGS_PROVIDER = "stand-in";
    const result = await checkStack(env);
    expect(result.apps["news-api"]?.ok).toBe(true);
  });

  it("fails the public site when the tenant's site-settings defaults file is invalid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gcpe-check-tenant-"));
    const config = join(dir, "bc.json");
    copyFileSync(fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url)), config);
    writeFileSync(join(dir, "bc.site-settings.json"), JSON.stringify({ footer: { moreInfoLinks: [{ id: "x", text: "Bad", url: "javascript:alert(1)" }] } }));
    const result = await checkStack({ ...baseEnv(), TENANT_CONFIG: config });
    expect(result.ok).toBe(false);
    expect(result.apps["public-site"]?.ok).toBe(false);
    expect(result.apps["public-site"]?.error).toMatch(/SITE_\*/);
    expect(result.apps.core?.ok).toBe(true);
  });
});

// Production configuration (owner decisions 2026-10-31): the real production shape, with the
// break-glass admin off, checked without a database.
describe("checkStack: real production", () => {
  const AUDIENCE = "api://22222222-2222-4222-8222-222222222222";
  function prodEnv(): NodeJS.ProcessEnv {
    const env = baseEnv();
    for (const k of ["LOCAL_ADMIN_ENABLED", "LOCAL_ADMIN_PASSWORD_HASH", "LOCAL_AUTH_SECRET", "DIST_MAIL_REDIRECT_TO"]) delete env[k];
    // The stack derives every event route and the internal service-token key from this.
    for (const k of Object.keys(env)) if (/_EVENT_(SUBSCRIBERS|SECRETS)$/.test(k)) delete env[k];
    return {
      ...env,
      NODE_ENV: "production",
      STACK_EVENT_SECRET: "e".repeat(48),
      ENTRA_TENANT_ID: "11111111-1111-4111-8111-111111111111",
      CORE_ENTRA_CLIENT_ID: "22222222-2222-4222-8222-222222222222",
      CORE_ENTRA_CLIENT_SECRET: "client-secret",
      CORE_PUBLIC_BASE_URL: "https://news.example.invalid",
      ...Object.fromEntries(["CORE", "NRMS", "NEWSAPI", "SITE", "NOD", "DIST", "CALENDAR"].map((p) => [`${p}_AUTH_AUDIENCE`, AUDIENCE])),
      NOD_EMERGENCY_FEED: "off",
      DIST_MAIL_ALLOW_REAL_RECIPIENTS: "true",
    };
  }

  it("passes with local admin off, and reports its warnings (emergency alerts off, bounces by manual upload)", async () => {
    const result = await checkStack(prodEnv());
    expect(result.apps).toEqual(expect.objectContaining({ core: expect.objectContaining({ ok: true }), nrms: expect.objectContaining({ ok: true }), nod: expect.objectContaining({ ok: true }) }));
    expect(result.ok).toBe(true);
    expect(result.production?.errors).toEqual([]);
    expect(result.production?.warnings.join("\n")).toMatch(/Emergency alerts are switched off/);
    expect(result.production?.warnings.join("\n")).toMatch(/Bounces aren't being read/);
  });

  it("fails, naming the setting, when real production has neither an emergency feed nor NOD_EMERGENCY_FEED=off", async () => {
    const env = prodEnv();
    delete env.NOD_EMERGENCY_FEED;
    const result = await checkStack(env);
    expect(result.ok).toBe(false);
    expect(result.production?.errors.join("\n")).toMatch(/NOD_EMERGENCY_FEED_URL/);
  });

  it("fails when the apps would have no way to call each other (no STACK_EVENT_SECRET, local admin off): the token each app builds at startup", async () => {
    const env = prodEnv();
    delete env.STACK_EVENT_SECRET;
    // Explicit event wiring instead, so only the service tokens are missing.
    Object.assign(env, { NOD_LINK_SECRET: "l".repeat(32), SESSION_SECRET: "s".repeat(40) });
    const result = await checkStack(env);
    expect(result.ok).toBe(false);
    expect(result.apps.nrms?.error).toMatch(/NOD_TOKEN_URL/);
    expect(result.apps.nod?.error).toMatch(/DISTRIBUTION_TOKEN_URL/);
    expect(result.apps["public-site"]?.error).toMatch(/NEWS_API_TOKEN_URL/);
    expect(result.apps["news-api"]?.error).toMatch(/NOD_TOKEN_URL/);
  });

  it("startStack refuses real production with a problem before touching any database or folder", async () => {
    const env = prodEnv();
    delete env.CORE_ENTRA_CLIENT_SECRET;
    env.DATA_DIR = "/nonexistent-gcpe-check/data";
    await expect(startStack(env)).rejects.toThrow(/refusing to start.*Microsoft sign-in/s);
  });
});
