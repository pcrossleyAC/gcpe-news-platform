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
    expect(() => parseEnv(newsApiEnvSchema, { ...BASE, EVENT_SECRETS: "{not json" } as unknown as NodeJS.ProcessEnv)).toThrowError(
      /^Invalid environment: EVENT_SECRETS: must be valid JSON$/,
    );
  });

  it("reports valid JSON that isn't an object of strings the same way", () => {
    expect(() => parseEnv(newsApiEnvSchema, { ...BASE, EVENT_SECRETS: "[1,2,3]" } as unknown as NodeJS.ProcessEnv)).toThrowError(
      /^Invalid environment: EVENT_SECRETS: must be a JSON object of string values$/,
    );
    expect(() => parseEnv(newsApiEnvSchema, { ...BASE, EVENT_SECRETS: '{"core":1}' } as unknown as NodeJS.ProcessEnv)).toThrowError(
      /^Invalid environment: EVENT_SECRETS: must be a JSON object of string values$/,
    );
  });
});
