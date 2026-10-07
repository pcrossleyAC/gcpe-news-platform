import { describe, expect, it } from "vitest";
import { distributionEnvSchema } from "./env";
const base = { DATABASE_URL: "postgres://x/y", SMTP_HOST: "localhost", MAIL_FROM: "news@example.com" };
describe("distribution env", () => {
  it("refuses to start with neither a redirect nor explicit real-recipient permission", () => {
    expect(distributionEnvSchema.safeParse(base).success).toBe(false);
  });
  it("accepts a redirect list or explicit permission", () => {
    expect(distributionEnvSchema.parse({ ...base, MAIL_REDIRECT_TO: "qa@example.com, dev@example.com" }).MAIL_REDIRECT_TO).toEqual(["qa@example.com", "dev@example.com"]);
    expect(distributionEnvSchema.parse({ ...base, MAIL_ALLOW_REAL_RECIPIENTS: "true" }).MAIL_ALLOW_REAL_RECIPIENTS).toBe(true);
  });
  it("treats MAIL_ALLOW_REAL_RECIPIENTS=false as false (not truthy string)", () => {
    expect(distributionEnvSchema.safeParse({ ...base, MAIL_ALLOW_REAL_RECIPIENTS: "false" }).success).toBe(false);
  });
  it("rejects a MAIL_REDIRECT_TO entry that isn't a valid email", () => {
    expect(distributionEnvSchema.safeParse({ ...base, MAIL_REDIRECT_TO: "qa@" }).success).toBe(false);
  });
  it("when both the redirect list and the real-recipient permission are set, the redirect list still parses through (and sender.ts only ever consults it)", () => {
    const parsed = distributionEnvSchema.parse({ ...base, MAIL_REDIRECT_TO: "qa@example.com", MAIL_ALLOW_REAL_RECIPIENTS: "true" });
    expect(parsed.MAIL_REDIRECT_TO).toEqual(["qa@example.com"]);
    expect(parsed.MAIL_ALLOW_REAL_RECIPIENTS).toBe(true);
  });
  it("treats a MAIL_REDIRECT_TO of only commas/whitespace as empty, and refuses to boot without explicit permission", () => {
    expect(distributionEnvSchema.safeParse({ ...base, MAIL_REDIRECT_TO: " , " }).success).toBe(false);
  });
  it("defaults the SMTP transport timeouts and pool size", () => {
    const parsed = distributionEnvSchema.parse({ ...base, MAIL_ALLOW_REAL_RECIPIENTS: "true" });
    expect(parsed.SMTP_CONNECTION_TIMEOUT_MS).toBe(10_000);
    expect(parsed.SMTP_GREETING_TIMEOUT_MS).toBe(10_000);
    expect(parsed.SMTP_SOCKET_TIMEOUT_MS).toBe(30_000);
    expect(parsed.SMTP_MAX_CONNECTIONS).toBe(3);
  });
  it("accepts overrides for the SMTP transport timeouts and pool size", () => {
    const parsed = distributionEnvSchema.parse({
      ...base,
      MAIL_ALLOW_REAL_RECIPIENTS: "true",
      SMTP_CONNECTION_TIMEOUT_MS: "5000",
      SMTP_GREETING_TIMEOUT_MS: "6000",
      SMTP_SOCKET_TIMEOUT_MS: "7000",
      SMTP_MAX_CONNECTIONS: "10",
    });
    expect(parsed).toMatchObject({ SMTP_CONNECTION_TIMEOUT_MS: 5000, SMTP_GREETING_TIMEOUT_MS: 6000, SMTP_SOCKET_TIMEOUT_MS: 7000, SMTP_MAX_CONNECTIONS: 10 });
  });
  it("defaults SEND_OUTAGE_COOLDOWN_MAX_MS to 5 minutes and accepts an override", () => {
    expect(distributionEnvSchema.parse({ ...base, MAIL_ALLOW_REAL_RECIPIENTS: "true" }).SEND_OUTAGE_COOLDOWN_MAX_MS).toBe(300_000);
    expect(distributionEnvSchema.parse({ ...base, MAIL_ALLOW_REAL_RECIPIENTS: "true", SEND_OUTAGE_COOLDOWN_MAX_MS: "60000" }).SEND_OUTAGE_COOLDOWN_MAX_MS).toBe(60_000);
  });
  it("defaults INTERNAL_DOMAINS to gov.bc.ca,leg.bc.ca", () => {
    expect(distributionEnvSchema.parse({ ...base, MAIL_ALLOW_REAL_RECIPIENTS: "true" }).INTERNAL_DOMAINS).toEqual(["gov.bc.ca", "leg.bc.ca"]);
  });
  it("accepts an INTERNAL_DOMAINS override, replacing the default entirely", () => {
    expect(distributionEnvSchema.parse({ ...base, MAIL_ALLOW_REAL_RECIPIENTS: "true", INTERNAL_DOMAINS: "example.com" }).INTERNAL_DOMAINS).toEqual(["example.com"]);
  });
  it("derives MESSAGE_ID_DOMAIN from MAIL_FROM's domain when unset", () => {
    expect(distributionEnvSchema.parse({ ...base, MAIL_ALLOW_REAL_RECIPIENTS: "true", MAIL_FROM: "news@example.com" }).MESSAGE_ID_DOMAIN).toBe("example.com");
  });
  it("derives MESSAGE_ID_DOMAIN from a \"Name <address>\" MAIL_FROM", () => {
    expect(
      distributionEnvSchema.parse({ ...base, MAIL_ALLOW_REAL_RECIPIENTS: "true", MAIL_FROM: "BC Gov News <news@example.com>" }).MESSAGE_ID_DOMAIN,
    ).toBe("example.com");
  });
  it("an explicit MESSAGE_ID_DOMAIN wins over MAIL_FROM's own domain", () => {
    expect(
      distributionEnvSchema.parse({ ...base, MAIL_ALLOW_REAL_RECIPIENTS: "true", MESSAGE_ID_DOMAIN: "mail.example.com" }).MESSAGE_ID_DOMAIN,
    ).toBe("mail.example.com");
  });
  it("fails startup when neither MESSAGE_ID_DOMAIN nor a MAIL_FROM domain is available", () => {
    expect(distributionEnvSchema.safeParse({ ...base, MAIL_ALLOW_REAL_RECIPIENTS: "true", MAIL_FROM: "not-an-address" }).success).toBe(false);
  });
  it("rejects a malformed MAIL_REPLY_TO", () => {
    expect(distributionEnvSchema.safeParse({ ...base, MAIL_ALLOW_REAL_RECIPIENTS: "true", MAIL_REPLY_TO: "not-an-address" }).success).toBe(false);
  });
  it("accepts a valid MAIL_REPLY_TO", () => {
    expect(distributionEnvSchema.parse({ ...base, MAIL_ALLOW_REAL_RECIPIENTS: "true", MAIL_REPLY_TO: "reply@example.com" }).MAIL_REPLY_TO).toBe("reply@example.com");
  });
  it("defaults MAIL_RATE_PER_MINUTE to 60", () => {
    expect(distributionEnvSchema.parse({ ...base, MAIL_ALLOW_REAL_RECIPIENTS: "true" }).MAIL_RATE_PER_MINUTE).toBe(60);
  });
  it("accepts a MAIL_RATE_PER_MINUTE override", () => {
    expect(distributionEnvSchema.parse({ ...base, MAIL_ALLOW_REAL_RECIPIENTS: "true", MAIL_RATE_PER_MINUTE: "10" }).MAIL_RATE_PER_MINUTE).toBe(10);
  });
  it("rejects MAIL_RATE_PER_MINUTE=0 — no \"unlimited\" value, so a typo can't remove the cap", () => {
    expect(distributionEnvSchema.safeParse({ ...base, MAIL_ALLOW_REAL_RECIPIENTS: "true", MAIL_RATE_PER_MINUTE: "0" }).success).toBe(false);
  });
  it("defaults MAIL_CONCURRENCY to 1", () => {
    expect(distributionEnvSchema.parse({ ...base, MAIL_ALLOW_REAL_RECIPIENTS: "true" }).MAIL_CONCURRENCY).toBe(1);
  });
  it("accepts a MAIL_CONCURRENCY override at or below SMTP_MAX_CONNECTIONS", () => {
    expect(
      distributionEnvSchema.parse({ ...base, MAIL_ALLOW_REAL_RECIPIENTS: "true", MAIL_CONCURRENCY: "3", SMTP_MAX_CONNECTIONS: "3" }).MAIL_CONCURRENCY,
    ).toBe(3);
  });
  it("rejects MAIL_CONCURRENCY below 1", () => {
    expect(distributionEnvSchema.safeParse({ ...base, MAIL_ALLOW_REAL_RECIPIENTS: "true", MAIL_CONCURRENCY: "0" }).success).toBe(false);
  });
  it("rejects MAIL_CONCURRENCY above 16", () => {
    expect(distributionEnvSchema.safeParse({ ...base, MAIL_ALLOW_REAL_RECIPIENTS: "true", MAIL_CONCURRENCY: "17" }).success).toBe(false);
  });
  it("fails startup when MAIL_CONCURRENCY exceeds SMTP_MAX_CONNECTIONS", () => {
    expect(
      distributionEnvSchema.safeParse({ ...base, MAIL_ALLOW_REAL_RECIPIENTS: "true", MAIL_CONCURRENCY: "4", SMTP_MAX_CONNECTIONS: "3" }).success,
    ).toBe(false);
  });
});
