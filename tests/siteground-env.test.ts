// Task 15: tests for scripts/siteground-env.ts's non-interactive mode — both the pure
// buildEnvLines()/generateSecrets() helpers, and (one test) the actual CLI entry point spawned
// as a real `tsx` child process reading SITEGROUND_* env vars, to prove --non-interactive
// genuinely works end to end, not just its internal helpers.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildEnvLines,
  collectNonInteractiveInput,
  generateSecret,
  generateSecrets,
  type SiteGroundEnvInput,
} from "../scripts/siteground-env";

const SCRIPT_PATH = fileURLToPath(new URL("../scripts/siteground-env.ts", import.meta.url));

function sampleInput(overrides: Partial<SiteGroundEnvInput> = {}): SiteGroundEnvInput {
  return {
    domain: "news.example.invalid",
    manageUrl: "https://legacy.example.invalid/manage",
    adminUsername: "admin",
    adminPasswordHash: "scrypt$16384$8$1$c2FsdA$a2V5",
    dbUser: "gcpe_app",
    dbPassword: "db-pass-with-@-and-&-chars",
    dbNames: { core: "gcpe_core", nrms: "gcpe_nrms", newsApi: "gcpe_news_api", site: "gcpe_site", nod: "gcpe_nod", distribution: "gcpe_distribution" },
    smtp: { host: "mail.example.invalid", port: 587, secure: false },
    mailFrom: "noreply@example.invalid",
    mailRedirectTo: ["ops@example.invalid"],
    ...overrides,
  };
}

function parseEnvLines(output: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of output.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    map.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return map;
}

describe("generateSecret / generateSecrets", () => {
  it("produces a >= 32 character secret (TICK_TOKEN/LOCAL_AUTH_SECRET's own minimum)", () => {
    expect(generateSecret().length).toBeGreaterThanOrEqual(32);
  });

  it("never repeats across calls", () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).not.toBe(b);
  });

  it("generates six independently-random secrets", () => {
    const s = generateSecrets();
    const values = Object.values(s);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("buildEnvLines", () => {
  it("never puts a self: URL on any *_DATABASE_URL line", () => {
    const lines = buildEnvLines(sampleInput(), generateSecrets());
    const map = parseEnvLines(lines.join("\n"));
    for (const [key, value] of map) {
      if (key.endsWith("DATABASE_URL")) {
        expect(value.startsWith("postgres://")).toBe(true);
        expect(value).not.toContain("self:");
      }
    }
  });

  it("URL-encodes a database password containing special characters", () => {
    const lines = buildEnvLines(sampleInput(), generateSecrets());
    const map = parseEnvLines(lines.join("\n"));
    expect(map.get("CORE_DATABASE_URL")).toContain(encodeURIComponent("db-pass-with-@-and-&-chars"));
    expect(map.get("CORE_DATABASE_URL")).not.toContain("db-pass-with-@-and-&-chars@"); // raw, unencoded @ would break the URL
  });

  it("builds PUBLIC_SITE_URL from the domain for both SITE and NOD, as https://<domain>/site", () => {
    const map = parseEnvLines(buildEnvLines(sampleInput({ domain: "news.gov.bc.ca" }), generateSecrets()).join("\n"));
    expect(map.get("SITE_PUBLIC_SITE_URL")).toBe("https://news.gov.bc.ca/site");
    expect(map.get("NOD_PUBLIC_SITE_URL")).toBe("https://news.gov.bc.ca/site");
  });

  it("emits one STACK_EVENT_SECRET instead of per-app EVENT_* JSON (the stack derives the wiring)", () => {
    const secrets = generateSecrets();
    const map = parseEnvLines(buildEnvLines(sampleInput(), secrets).join("\n"));
    expect(map.get("STACK_EVENT_SECRET")).toBe(secrets.stackEventSecret);
    expect(secrets.stackEventSecret.length).toBeGreaterThanOrEqual(32);
    expect([...map.keys()].filter((k) => /EVENT_(SUBSCRIBERS|SECRETS)$/.test(k))).toEqual([]);
  });

  it("keeps every value short enough for SiteGround's env form (< 255 bytes)", () => {
    const map = parseEnvLines(buildEnvLines(sampleInput(), generateSecrets()).join("\n"));
    const tooLong = [...map.entries()].filter(([, v]) => Buffer.byteLength(v, "utf8") >= 255).map(([k]) => k);
    expect(tooLong).toEqual([]);
  });

  it("never sets PORT (SiteGround injects it)", () => {
    const map = parseEnvLines(buildEnvLines(sampleInput(), generateSecrets()).join("\n"));
    expect(map.has("PORT")).toBe(false);
  });

  it("omits DIST_SMTP_USER/PASS when no SMTP user was given, includes them when one was", () => {
    const withoutUser = parseEnvLines(buildEnvLines(sampleInput(), generateSecrets()).join("\n"));
    expect(withoutUser.has("DIST_SMTP_USER")).toBe(false);
    expect(withoutUser.has("DIST_SMTP_PASS")).toBe(false);

    const withUser = parseEnvLines(
      buildEnvLines(sampleInput({ smtp: { host: "mail.example.invalid", port: 587, secure: false, user: "mailbox@example.invalid", pass: "smtp-pass" } }), generateSecrets()).join("\n"),
    );
    expect(withUser.get("DIST_SMTP_USER")).toBe("mailbox@example.invalid");
    expect(withUser.get("DIST_SMTP_PASS")).toBe("smtp-pass");
  });
});

describe("collectNonInteractiveInput", () => {
  it("throws, naming every missing var at once, when required SITEGROUND_* vars are absent", async () => {
    await expect(collectNonInteractiveInput({})).rejects.toThrow(/SITEGROUND_DOMAIN/);
    await expect(collectNonInteractiveInput({})).rejects.toThrow(/SITEGROUND_MAIL_REDIRECT_TO/);
  });

  it("builds a full SiteGroundEnvInput from env vars, hashing the raw admin password", async () => {
    const input = await collectNonInteractiveInput({
      SITEGROUND_DOMAIN: "news.example.invalid",
      SITEGROUND_MANAGE_URL: "https://legacy.example.invalid/manage",
      SITEGROUND_ADMIN_PASSWORD: "a-test-password-123",
      SITEGROUND_DB_USER: "gcpe_app",
      SITEGROUND_DB_PASSWORD: "db-pass",
      SITEGROUND_SMTP_HOST: "mail.example.invalid",
      SITEGROUND_MAIL_FROM: "noreply@example.invalid",
      SITEGROUND_MAIL_REDIRECT_TO: "ops@example.invalid,qa@example.invalid",
    });
    expect(input.domain).toBe("news.example.invalid");
    expect(input.adminUsername).toBe("admin"); // default
    expect(input.adminPasswordHash).toMatch(/^scrypt\$/);
    expect(input.adminPasswordHash).not.toContain("a-test-password-123"); // never the raw password
    expect(input.mailRedirectTo).toEqual(["ops@example.invalid", "qa@example.invalid"]);
    expect(input.dbNames.core).toBe("gcpe_core"); // default prefix
  });

  it("honors an explicit SITEGROUND_DB_PREFIX and per-app db name overrides", async () => {
    const input = await collectNonInteractiveInput({
      SITEGROUND_DOMAIN: "news.example.invalid",
      SITEGROUND_MANAGE_URL: "https://legacy.example.invalid/manage",
      SITEGROUND_ADMIN_PASSWORD: "a-test-password-123",
      SITEGROUND_DB_USER: "gcpe_app",
      SITEGROUND_DB_PASSWORD: "db-pass",
      SITEGROUND_DB_PREFIX: "custom",
      SITEGROUND_DB_NAME_NOD: "nod_override",
      SITEGROUND_SMTP_HOST: "mail.example.invalid",
      SITEGROUND_MAIL_FROM: "noreply@example.invalid",
      SITEGROUND_MAIL_REDIRECT_TO: "ops@example.invalid",
    });
    expect(input.dbNames.core).toBe("custom_core");
    expect(input.dbNames.nod).toBe("nod_override");
  });

  // Ruling P2-R34: the interactive prompt enforces >= 12 characters (and effectively rejects
  // empty, via the "required" check) — non-interactive mode must enforce exactly the same
  // rule, not let a short password sail through into a real LOCAL_ADMIN_PASSWORD_HASH.
  it("rejects a SITEGROUND_ADMIN_PASSWORD shorter than 12 characters", async () => {
    await expect(
      collectNonInteractiveInput({
        SITEGROUND_DOMAIN: "news.example.invalid",
        SITEGROUND_MANAGE_URL: "https://legacy.example.invalid/manage",
        SITEGROUND_ADMIN_PASSWORD: "short1",
        SITEGROUND_DB_USER: "gcpe_app",
        SITEGROUND_DB_PASSWORD: "db-pass",
        SITEGROUND_SMTP_HOST: "mail.example.invalid",
        SITEGROUND_MAIL_FROM: "noreply@example.invalid",
        SITEGROUND_MAIL_REDIRECT_TO: "ops@example.invalid",
      }),
    ).rejects.toThrow(/at least 12 characters/);
  });

  it("rejects an empty SITEGROUND_ADMIN_PASSWORD (as a missing required var)", async () => {
    await expect(
      collectNonInteractiveInput({
        SITEGROUND_DOMAIN: "news.example.invalid",
        SITEGROUND_MANAGE_URL: "https://legacy.example.invalid/manage",
        SITEGROUND_ADMIN_PASSWORD: "",
        SITEGROUND_DB_USER: "gcpe_app",
        SITEGROUND_DB_PASSWORD: "db-pass",
        SITEGROUND_SMTP_HOST: "mail.example.invalid",
        SITEGROUND_MAIL_FROM: "noreply@example.invalid",
        SITEGROUND_MAIL_REDIRECT_TO: "ops@example.invalid",
      }),
    ).rejects.toThrow(/SITEGROUND_ADMIN_PASSWORD/);
  });

  it("accepts a SITEGROUND_ADMIN_PASSWORD exactly 12 characters long", async () => {
    const input = await collectNonInteractiveInput({
      SITEGROUND_DOMAIN: "news.example.invalid",
      SITEGROUND_MANAGE_URL: "https://legacy.example.invalid/manage",
      SITEGROUND_ADMIN_PASSWORD: "exactly12chr",
      SITEGROUND_DB_USER: "gcpe_app",
      SITEGROUND_DB_PASSWORD: "db-pass",
      SITEGROUND_SMTP_HOST: "mail.example.invalid",
      SITEGROUND_MAIL_FROM: "noreply@example.invalid",
      SITEGROUND_MAIL_REDIRECT_TO: "ops@example.invalid",
    });
    expect(input.adminPasswordHash).toMatch(/^scrypt\$/);
  });
});

describe("CLI entry point, --non-interactive (real child process)", () => {
  it("prints a full, valid env block to stdout and never echoes the raw admin password", () => {
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", SCRIPT_PATH, "--non-interactive"],
      {
        env: {
          ...process.env,
          SITEGROUND_DOMAIN: "news.example.invalid",
          SITEGROUND_MANAGE_URL: "https://legacy.example.invalid/manage",
          SITEGROUND_ADMIN_PASSWORD: "cli-test-password-999",
          SITEGROUND_DB_USER: "gcpe_app",
          SITEGROUND_DB_PASSWORD: "cli-db-password",
          SITEGROUND_SMTP_HOST: "mail.example.invalid",
          SITEGROUND_MAIL_FROM: "noreply@example.invalid",
          SITEGROUND_MAIL_REDIRECT_TO: "ops@example.invalid",
        },
        encoding: "utf8",
      },
    );
    expect(output).not.toContain("cli-test-password-999");
    const map = parseEnvLines(output);
    expect(map.get("DIST_MAIL_FROM")).toBe("noreply@example.invalid");
    expect(map.get("LOCAL_ADMIN_PASSWORD_HASH")).toMatch(/^scrypt\$/);
    expect(map.get("CORE_DATABASE_URL")).toContain("cli-db-password");
    expect(map.get("TICK_TOKEN")!.length).toBeGreaterThanOrEqual(32);
  });
});
