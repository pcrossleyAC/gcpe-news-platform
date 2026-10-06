import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "@gcpe/config";
import { describe, expect, it } from "vitest";
import { newsApiEnvSchema } from "./env";

const BASE = { DATABASE_URL: "postgres://localhost:5432/news_api" };

describe("newsApiEnvSchema EVENT_SECRETS", () => {
  it("defaults to an empty object", () => {
    const env = parseEnv(newsApiEnvSchema, BASE as unknown as NodeJS.ProcessEnv);
    expect(env.EVENT_SECRETS).toEqual({});
  });

  it("parses a valid JSON object of strings", () => {
    const env = parseEnv(newsApiEnvSchema, { ...BASE, EVENT_SECRETS: '{"core":"dev","nrms":"dev"}' } as unknown as NodeJS.ProcessEnv);
    expect(env.EVENT_SECRETS).toEqual({ core: "dev", nrms: "dev" });
  });

  // Review fix round 1, point 2: invalid JSON used to throw a raw SyntaxError straight out
  // of main.ts (from JSON.parse) instead of parseEnv's own "Invalid environment: …" message.
  it("reports invalid JSON through parseEnv's own error format, not a raw SyntaxError", () => {
    expect(() => parseEnv(newsApiEnvSchema, { ...BASE, EVENT_SECRETS: "{not json" } as unknown as NodeJS.ProcessEnv)).toThrow(
      /^Invalid environment: EVENT_SECRETS: must be valid JSON$/,
    );
  });

  it("reports valid JSON that isn't an object of strings the same way", () => {
    expect(() => parseEnv(newsApiEnvSchema, { ...BASE, EVENT_SECRETS: "[1,2,3]" } as unknown as NodeJS.ProcessEnv)).toThrow(
      /^Invalid environment: EVENT_SECRETS: must be a JSON object of string values$/,
    );
    expect(() => parseEnv(newsApiEnvSchema, { ...BASE, EVENT_SECRETS: '{"core":1}' } as unknown as NodeJS.ProcessEnv)).toThrow(
      /^Invalid environment: EVENT_SECRETS: must be a JSON object of string values$/,
    );
  });
});

describe("newsApiEnvSchema updates hub limits", () => {
  it("defaults negotiate rate limit to 120/min, max connections to 5000, and per-IP max connections to 50", () => {
    const env = parseEnv(newsApiEnvSchema, BASE as unknown as NodeJS.ProcessEnv);
    expect(env.UPDATES_NEGOTIATE_RATE_LIMIT_PER_MIN).toBe(120);
    expect(env.UPDATES_MAX_CONNECTIONS).toBe(5000);
    expect(env.UPDATES_MAX_CONNECTIONS_PER_IP).toBe(50);
  });

  it("accepts overrides", () => {
    const env = parseEnv(newsApiEnvSchema, {
      ...BASE,
      UPDATES_NEGOTIATE_RATE_LIMIT_PER_MIN: "10",
      UPDATES_MAX_CONNECTIONS: "50",
      UPDATES_MAX_CONNECTIONS_PER_IP: "3",
    } as unknown as NodeJS.ProcessEnv);
    expect(env.UPDATES_NEGOTIATE_RATE_LIMIT_PER_MIN).toBe(10);
    expect(env.UPDATES_MAX_CONNECTIONS).toBe(50);
    expect(env.UPDATES_MAX_CONNECTIONS_PER_IP).toBe(3);
  });
});

describe("newsApiEnvSchema SUBSCRIBE_CLIENT_IP_HEADER", () => {
  it("is unset by default and passes through when configured", () => {
    expect(parseEnv(newsApiEnvSchema, BASE as unknown as NodeJS.ProcessEnv).SUBSCRIBE_CLIENT_IP_HEADER).toBeUndefined();
    const env = parseEnv(newsApiEnvSchema, { ...BASE, SUBSCRIBE_CLIENT_IP_HEADER: "x-client-ip" } as unknown as NodeJS.ProcessEnv);
    expect(env.SUBSCRIBE_CLIENT_IP_HEADER).toBe("x-client-ip");
  });
});

// Final review D2: path defaults are derived with fileURLToPath, not URL#pathname — the latter
// leaves percent-encoding in place ("/a%20b/…" for a checkout under "/a b/"), producing a path
// that doesn't exist.
describe("newsApiEnvSchema path defaults", () => {
  it("resolve to existing filesystem paths", () => {
    const env = parseEnv(newsApiEnvSchema, BASE as unknown as NodeJS.ProcessEnv);
    expect(existsSync(env.TENANT_CONFIG)).toBe(true);
    expect(existsSync(join(env.MIGRATIONS_FOLDER, "meta", "_journal.json"))).toBe(true);
  });

  it("fileURLToPath decodes what URL#pathname would leave percent-encoded", () => {
    const url = new URL("../migrations", "file:///srv/my%20checkout/apps/news-api/src/env.ts");
    expect(url.pathname).toBe("/srv/my%20checkout/apps/news-api/migrations");
    expect(fileURLToPath(url)).toBe("/srv/my checkout/apps/news-api/migrations");
  });
});
