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
});
