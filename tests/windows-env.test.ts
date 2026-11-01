// scripts/windows-env.ts: the env file the Windows installer writes, read back by Node's own
// --env-file parser (the service runs `node --env-file=gcpe.env stack.js`), and the importers'
// EVENT_SUBSCRIBERS derived the way the running stack derives its own.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { internalEventEnv } from "../apps/stack/src/env";
import { parseJsonQuietly } from "../scripts/windows-json";
import { buildWindowsEnvLines, envLine, eventSubscribersFor, generateSecrets, windowsEnvInputSchema, type WindowsEnvInput } from "../scripts/windows-env";

const HASH = "scrypt$16384$8$1$c2FsdHNhbHRzYWx0c2FsdA$a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5";

function input(overrides: Partial<WindowsEnvInput> = {}): WindowsEnvInput {
  return {
    hostName: "news-dev.example.gov.bc.ca",
    dataDir: "D:\\gcpe\\data",
    port: 3000,
    adminUsername: "admin",
    adminPassword: "correct horse battery",
    db: { host: "localhost", port: 5432, user: "gcpe", password: "p@ss/word#1", prefix: "gcpe" },
    smtp: { host: "apps.smtp.gov.bc.ca", port: 25, secure: false },
    mailFrom: "noreply@example.gov.bc.ca",
    mailRedirectTo: ["dev-inbox@example.gov.bc.ca"],
    ...overrides,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** What Node itself reads from the file with --env-file: the only reader that matters. */
function readWithNode(lines: string[], keys: string[]): Record<string, string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "windows-env-"));
  dirs.push(dir);
  const file = join(dir, "gcpe.env");
  writeFileSync(file, lines.join("\n") + "\n");
  const out = execFileSync(process.execPath, [`--env-file=${file}`, "-e", `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map((k) => [k, process.env[k]]))))`], {
    env: { PATH: process.env.PATH ?? "" },
  });
  return JSON.parse(out.toString("utf8")) as Record<string, string | undefined>;
}

describe("buildWindowsEnvLines", () => {
  it("marks the deployment as a test site with local admin as break-glass and the loops on", () => {
    const env = readWithNode(buildWindowsEnvLines(input(), HASH, generateSecrets()), [
      "NODE_ENV",
      "SITE_ENVIRONMENT",
      "LOCAL_ADMIN_ENABLED",
      "LOCAL_ADMIN_ALLOW_IN_PRODUCTION",
      "STACK_LOOPS",
      "UPDATES_HUB_ENABLED",
      "PORT",
    ]);
    expect(env).toEqual({
      NODE_ENV: "production",
      SITE_ENVIRONMENT: "test",
      LOCAL_ADMIN_ENABLED: "true",
      LOCAL_ADMIN_ALLOW_IN_PRODUCTION: "true",
      STACK_LOOPS: "true",
      UPDATES_HUB_ENABLED: "true",
      PORT: "3000",
    });
  });

  it("round-trips Windows paths, the password hash and awkward passwords through Node's --env-file", () => {
    const secrets = generateSecrets();
    const lines = buildWindowsEnvLines(
      input({ smtp: { host: "smtp.example.test", port: 587, secure: true, user: "relay user", pass: "it's #1 = best" } }),
      HASH,
      secrets,
    );
    const env = readWithNode(lines, ["DATA_DIR", "LOCAL_ADMIN_PASSWORD_HASH", "CORE_DATABASE_URL", "DIST_SMTP_USER", "DIST_SMTP_PASS", "STACK_EVENT_SECRET", "TICK_TOKEN"]);
    expect(env.DATA_DIR).toBe("D:\\gcpe\\data");
    expect(env.LOCAL_ADMIN_PASSWORD_HASH).toBe(HASH);
    expect(env.CORE_DATABASE_URL).toBe("postgres://gcpe:p%40ss%2Fword%231@localhost:5432/gcpe_core");
    expect(env.DIST_SMTP_USER).toBe("relay user");
    expect(env.DIST_SMTP_PASS).toBe("it's #1 = best");
    expect(env.STACK_EVENT_SECRET).toBe(secrets.stackEventSecret);
    expect(env.TICK_TOKEN).toBe(secrets.tickToken);
  });

  it("gives every app a database named <prefix>_<app>", () => {
    const keys = ["CORE", "NRMS", "NEWSAPI", "SITE", "NOD", "DIST", "CALENDAR"].map((p) => `${p}_DATABASE_URL`);
    const env = readWithNode(buildWindowsEnvLines(input(), HASH, generateSecrets()), keys);
    expect(Object.values(env).map((u) => new URL(u!).pathname)).toEqual([
      "/gcpe_core",
      "/gcpe_nrms",
      "/gcpe_news_api",
      "/gcpe_site",
      "/gcpe_nod",
      "/gcpe_distribution",
      "/gcpe_calendar",
    ]);
  });

  it("leaves Entra off unless it is configured, and then sets every app's audience", () => {
    expect(buildWindowsEnvLines(input(), HASH, generateSecrets()).some((l) => l.startsWith("ENTRA_"))).toBe(false);
    const entra = { tenantId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222", clientSecret: "s3cr#t", audience: "api://22222222-2222-4222-8222-222222222222" };
    const keys = ["ENTRA_TENANT_ID", "CORE_ENTRA_CLIENT_ID", "CORE_ENTRA_CLIENT_SECRET", "CORE_PUBLIC_BASE_URL", ...["CORE", "NRMS", "NEWSAPI", "SITE", "NOD", "DIST", "CALENDAR"].map((p) => `${p}_AUTH_AUDIENCE`)];
    const env = readWithNode(buildWindowsEnvLines(input({ entra }), HASH, generateSecrets()), keys);
    expect(env.ENTRA_TENANT_ID).toBe(entra.tenantId);
    expect(env.CORE_ENTRA_CLIENT_SECRET).toBe("s3cr#t");
    expect(env.CORE_PUBLIC_BASE_URL).toBe("https://news-dev.example.gov.bc.ca");
    for (const p of ["CORE", "NRMS", "NEWSAPI", "SITE", "NOD", "DIST", "CALENDAR"]) expect(env[`${p}_AUTH_AUDIENCE`]).toBe(entra.audience);
  });

  it("serves the public site at the bare origin for both SITE and NOD", () => {
    const env = readWithNode(buildWindowsEnvLines(input(), HASH, generateSecrets()), ["SITE_PUBLIC_SITE_URL", "NOD_PUBLIC_SITE_URL"]);
    expect(env).toEqual({ SITE_PUBLIC_SITE_URL: "https://news-dev.example.gov.bc.ca", NOD_PUBLIC_SITE_URL: "https://news-dev.example.gov.bc.ca" });
  });
});

describe("Search Console verification inputs", () => {
  const keys = ["SITE_GOOGLE_VERIFICATION_FILE", "SITE_GOOGLE_SITE_VERIFICATION"];
  it("are emitted as SITE_GOOGLE_* only when given, and read back by Node", () => {
    expect(buildWindowsEnvLines(input(), HASH, generateSecrets()).join("\n")).not.toContain("SITE_GOOGLE");
    const env = readWithNode(buildWindowsEnvLines(input({ googleVerificationFile: "google790b0529c8dcfaff.html", googleSiteVerification: "ss-eO0gSqB1_GY5aWryEXVmGQBHJgpe9-hdwcskzjss" }), HASH, generateSecrets()), keys);
    expect(env).toEqual({ SITE_GOOGLE_VERIFICATION_FILE: "google790b0529c8dcfaff.html", SITE_GOOGLE_SITE_VERIFICATION: "ss-eO0gSqB1_GY5aWryEXVmGQBHJgpe9-hdwcskzjss" });
  });
  it("the schema refuses a path or markup in either value", () => {
    const ok = windowsEnvInputSchema.safeParse({ ...input(), googleVerificationFile: "google790b0529c8dcfaff.html", googleSiteVerification: "abcdefghij0123456789" });
    expect(ok.success).toBe(true);
    expect(windowsEnvInputSchema.safeParse({ ...input(), googleVerificationFile: "../x.html" }).success).toBe(false);
    expect(windowsEnvInputSchema.safeParse({ ...input(), googleSiteVerification: 'abcdefghij0123456789"' }).success).toBe(false);
  });
});

describe("windowsEnvInputSchema", () => {
  it("accepts the sample input", () => {
    expect(windowsEnvInputSchema.safeParse(input()).success).toBe(true);
  });

  it.each([
    ["no mail redirect", { mailRedirectTo: [] }],
    ["a short admin password", { adminPassword: "short" }],
    ["a relative data directory", { dataDir: "gcpe\\data" }],
    ["a URL instead of a host name", { hostName: "https://news.example.test" }],
    ["a line break in a value", { smtp: { host: "smtp", port: 25, secure: false, pass: "a\nb" } }],
  ])("rejects %s", (_label, overrides) => {
    expect(windowsEnvInputSchema.safeParse(input(overrides as Partial<WindowsEnvInput>)).success).toBe(false);
  });
});

describe("envLine", () => {
  it("leaves plain values bare and quotes anything else", () => {
    expect(envLine("A", "postgres://u:p@localhost:5432/db")).toBe("A=postgres://u:p@localhost:5432/db");
    expect(envLine("A", "D:\\x")).toBe("A='D:\\x'");
    expect(envLine("A", "it's")).toBe('A="it\'s"');
  });
});

describe("eventSubscribersFor", () => {
  const secret = "s".repeat(64);
  const env = { STACK_EVENT_SECRET: secret, PORT: "3000", CALENDAR_DATABASE_URL: "postgres://x@localhost/c" };

  it("matches the stack's own subscriber names, types and secrets, with self: resolved to loopback", () => {
    const ours = JSON.parse(eventSubscribersFor("CORE", env)) as { name: string; url: string; secret: string; types: string[] }[];
    const stacks = JSON.parse(internalEventEnv(secret).CORE.EVENT_SUBSCRIBERS!) as typeof ours;
    expect(ours.map(({ name, secret: s, types }) => ({ name, s, types }))).toEqual(stacks.map(({ name, secret: s, types }) => ({ name, s, types })));
    expect(ours.map((s) => s.name).sort()).toEqual(["calendar", "news-api", "nod", "nrms"]);
    expect(ours.every((s) => s.url.startsWith("http://127.0.0.1:3000/"))).toBe(true);
  });

  it("drops the Calendar's routes when the Calendar isn't configured, as the stack does", () => {
    const names = (JSON.parse(eventSubscribersFor("CORE", { STACK_EVENT_SECRET: secret })) as { name: string }[]).map((s) => s.name);
    expect(names).not.toContain("calendar");
  });

  it("refuses an unknown prefix and a missing secret", () => {
    expect(() => eventSubscribersFor("NOPE", env)).toThrow(/unknown app prefix/);
    expect(() => eventSubscribersFor("CORE", {})).toThrow(/STACK_EVENT_SECRET/);
  });
});

describe("parseJsonQuietly", () => {
  it("ignores the byte-order mark Windows PowerShell 5.1 puts at the start of a child's stdin", () => {
    expect(parseJsonQuietly('\uFEFF{"a":1}')).toEqual({ a: 1 });
  });

  it("never repeats the input in its error, since the input carries passwords", () => {
    expect(() => parseJsonQuietly('{"adminPassword":"hunter2-secret\\q"}')).toThrow("the input on stdin is not valid JSON");
    try {
      parseJsonQuietly('{"adminPassword":"hunter2-secret\\q"}');
    } catch (e) {
      expect(String(e)).not.toContain("hunter2");
    }
  });
});

describe("proxy hops input", () => {
  it("writes TRUST_PROXY_HOPS, 1 when not given, and the schema accepts 1-5 only", () => {
    expect(readWithNode(buildWindowsEnvLines(input(), HASH, generateSecrets()), ["TRUST_PROXY_HOPS"])).toEqual({ TRUST_PROXY_HOPS: "1" });
    expect(readWithNode(buildWindowsEnvLines(input({ proxyHops: 2 }), HASH, generateSecrets()), ["TRUST_PROXY_HOPS"])).toEqual({ TRUST_PROXY_HOPS: "2" });
    for (const n of [1, 5]) expect(windowsEnvInputSchema.safeParse({ ...input(), proxyHops: n }).success).toBe(true);
    for (const n of [0, 6, 1.5, "2"]) expect(windowsEnvInputSchema.safeParse({ ...input(), proxyHops: n }).success, String(n)).toBe(false);
  });
});

// Production configuration T3 (owner approved 2026-10-31): Install-Gcpe.ps1 -Environment Prod.
describe("production mode", () => {
  const entra = { tenantId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222", clientSecret: "s3cr#t", audience: "api://22222222-2222-4222-8222-222222222222" };
  const prod = (over: Partial<WindowsEnvInput> = {}): WindowsEnvInput => input({ environment: "prod", entra, mailRedirectTo: [], emergencyFeedUrl: "https://www.emergencyinfobc.gov.bc.ca/category/alerts/feed/?hide_expired=true", ...over });
  const ALL = ["NODE_ENV", "SITE_ENVIRONMENT", "LOCAL_ADMIN_ENABLED", "LOCAL_ADMIN_ALLOW_IN_PRODUCTION", "DIST_MAIL_REDIRECT_TO", "DIST_MAIL_ALLOW_REAL_RECIPIENTS", "NOD_EMERGENCY_FEED_URL", "NOD_EMERGENCY_FEED"];

  it("is the real production site from its first start: no SITE_ENVIRONMENT, break-glass on for setting up (P4 removes it), real mail, the emergency feed", () => {
    expect(readWithNode(buildWindowsEnvLines(windowsEnvInputSchema.parse(prod()), HASH, generateSecrets()), ALL)).toEqual({
      NODE_ENV: "production",
      SITE_ENVIRONMENT: undefined,
      LOCAL_ADMIN_ENABLED: "true",
      LOCAL_ADMIN_ALLOW_IN_PRODUCTION: "true",
      DIST_MAIL_REDIRECT_TO: undefined,
      DIST_MAIL_ALLOW_REAL_RECIPIENTS: "true",
      NOD_EMERGENCY_FEED_URL: "https://www.emergencyinfobc.gov.bc.ca/category/alerts/feed/?hide_expired=true",
      NOD_EMERGENCY_FEED: undefined,
    });
  });

  it("keeps redirecting mail until go-live when a redirect is given, and can switch emergency alerts off on purpose", () => {
    const env = readWithNode(buildWindowsEnvLines(windowsEnvInputSchema.parse(prod({ mailRedirectTo: ["prod-inbox@example.gov.bc.ca"], emergencyFeedUrl: undefined, emergencyFeedOff: true })), HASH, generateSecrets()), ALL);
    expect(env).toMatchObject({ DIST_MAIL_REDIRECT_TO: "prod-inbox@example.gov.bc.ca", NOD_EMERGENCY_FEED: "off" });
    expect(env.DIST_MAIL_ALLOW_REAL_RECIPIENTS).toBeUndefined();
    expect(env.NOD_EMERGENCY_FEED_URL).toBeUndefined();
  });

  it("what it writes passes the stack's real-production checks, break-glass included", async () => {
    const { productionProblems } = await import("../apps/stack/src/env");
    const { authFromEnv } = await import("../packages/auth/src/from-env");
    const { hashPassword } = await import("../packages/auth/src/password");
    const lines = buildWindowsEnvLines(windowsEnvInputSchema.parse(prod()), await hashPassword("correct horse battery"), generateSecrets());
    const env = readWithNode(lines, [...ALL, "ENTRA_TENANT_ID", "CORE_ENTRA_CLIENT_ID", "CORE_ENTRA_CLIENT_SECRET", "CORE_PUBLIC_BASE_URL", "LOCAL_ADMIN_PASSWORD_HASH", "LOCAL_AUTH_SECRET", "CORE_AUTH_AUDIENCE"]);
    const defined = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as NodeJS.ProcessEnv;
    expect(productionProblems(defined).errors).toEqual([]);
    expect(() => authFromEnv({ ...defined, AUTH_AUDIENCE: defined.CORE_AUTH_AUDIENCE })).not.toThrow();
  });

  it.each([
    ["no Entra", { entra: undefined }],
    ["no emergency feed and no explicit off", { emergencyFeedUrl: undefined }],
    ["both an emergency feed and off", { emergencyFeedOff: true }],
  ])("refuses %s", (_label, over) => {
    expect(windowsEnvInputSchema.safeParse(prod(over as Partial<WindowsEnvInput>)).success).toBe(false);
  });

  it("a test site still needs a mail redirect, and is the default", () => {
    expect(windowsEnvInputSchema.parse(input()).environment).toBe("test");
    expect(windowsEnvInputSchema.safeParse(input({ environment: "test", mailRedirectTo: [] })).success).toBe(false);
  });
});
