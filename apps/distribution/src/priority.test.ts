import { describe, expect, it } from "vitest";
import { distributionEnvSchema } from "./env";
import { priorityFor } from "./priority";
describe("priorityFor", () => {
  it("uses the spec's base priorities", () => {
    expect([priorityFor("system", "a@x.com", []), priorityFor("media", "a@x.com", []), priorityFor("immediate", "a@x.com", []), priorityFor("digest", "a@x.com", [])]).toEqual([100, 40, 30, 20]);
  });
  it("adds 2 for internal domains, case-insensitively, exact domain only", () => {
    expect(priorityFor("immediate", "Alex.Example@GOV.BC.CA", ["gov.bc.ca"])).toBe(32);
    expect(priorityFor("immediate", "a@notgov.bc.ca", ["gov.bc.ca"])).toBe(30);
  });
  it("an @gov.bc.ca (and @leg.bc.ca) recipient gets +2 by default — env.ts's INTERNAL_DOMAINS default", () => {
    const { INTERNAL_DOMAINS } = distributionEnvSchema.parse({ DATABASE_URL: "postgres://x/y", SMTP_HOST: "localhost", MAIL_FROM: "news@example.com", MAIL_ALLOW_REAL_RECIPIENTS: "true" });
    expect(priorityFor("immediate", "a@gov.bc.ca", INTERNAL_DOMAINS)).toBe(32);
    expect(priorityFor("immediate", "a@leg.bc.ca", INTERNAL_DOMAINS)).toBe(32);
    expect(priorityFor("immediate", "a@example.com", INTERNAL_DOMAINS)).toBe(30);
  });
});
