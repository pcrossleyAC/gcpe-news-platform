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
});
