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
