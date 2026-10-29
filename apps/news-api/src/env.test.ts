import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "@gcpe/config";
import { describe, expect, it } from "vitest";
import { newsApiEnvSchema } from "./env";

const BASE = { DATABASE_URL: "postgres://localhost:5432/news_api", SLIDE_IMAGES_FETCH_BASE: "http://stack.internal/files" };

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

describe("newsApiEnvSchema search settings", () => {
  it("defaults the semantic threshold to 0.6 and the search rate limit to 60 a minute", () => {
    const env = parseEnv(newsApiEnvSchema, BASE as unknown as NodeJS.ProcessEnv);
    expect(env.SEARCH_SEMANTIC_THRESHOLD).toBe(0.6);
    expect(env.SEARCH_RATE_LIMIT_PER_MIN).toBe(60);
  });

  it.each([
    ["SEARCH_SEMANTIC_THRESHOLD", "2.5"],
    ["SEARCH_SEMANTIC_THRESHOLD", "-0.1"],
    ["SEARCH_RATE_LIMIT_PER_MIN", "0"],
  ])("refuses %s=%s", (name, value) => {
    expect(newsApiEnvSchema.safeParse({ ...BASE, [name]: value }).success).toBe(false);
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
    // Built from a platform path: "file:///srv/..." has no drive letter, so isn't absolute on Windows.
    const checkout = resolve("/srv/my checkout");
    const url = new URL("../migrations", pathToFileURL(join(checkout, "apps/news-api/src/env.ts")));
    expect(url.pathname).toContain("my%20checkout/apps/news-api/migrations");
    expect(fileURLToPath(url)).toBe(join(checkout, "apps/news-api/migrations"));
  });
});

describe("newsApiEnvSchema PUBLIC_SITE_URL", () => {
  it("is optional and must be a URL when set", () => {
    expect(parseEnv(newsApiEnvSchema, BASE as unknown as NodeJS.ProcessEnv).PUBLIC_SITE_URL).toBeUndefined();
    expect(() => parseEnv(newsApiEnvSchema, { ...BASE, PUBLIC_SITE_URL: "boxs.ca/site" } as unknown as NodeJS.ProcessEnv)).toThrow(/PUBLIC_SITE_URL/);
  });
});

describe("newsApiEnvSchema SLIDE_IMAGES_FETCH_BASE", () => {
  it("is required and must be a URL", () => {
    const env = parseEnv(newsApiEnvSchema, BASE as unknown as NodeJS.ProcessEnv);
    expect(env.SLIDE_IMAGES_FETCH_BASE).toBe("http://stack.internal/files");
    expect(() => parseEnv(newsApiEnvSchema, { ...BASE, SLIDE_IMAGES_FETCH_BASE: "not-a-url" } as unknown as NodeJS.ProcessEnv)).toThrow(/SLIDE_IMAGES_FETCH_BASE/);
  });

  // The fetch never falls back to the event's own imageUrl, so without this set the News API
  // can't safely fetch slide images at all — it refuses to start with a clear message, the
  // same way it refuses to start with a bad DATABASE_URL (both are the one schema's job).
  it("refuses to start when it's unset, with a clear message naming it", () => {
    const { SLIDE_IMAGES_FETCH_BASE: _omit, ...withoutIt } = BASE;
    expect(() => parseEnv(newsApiEnvSchema, withoutIt as unknown as NodeJS.ProcessEnv)).toThrow(/SLIDE_IMAGES_FETCH_BASE/);
  });
});

describe("newsApiEnvSchema embeddings", () => {
  it("has no provider by default, and the default timeout", () => {
    const env = parseEnv(newsApiEnvSchema, BASE as unknown as NodeJS.ProcessEnv);
    expect(env.EMBEDDINGS_PROVIDER).toBeUndefined();
    expect(env.EMBEDDINGS_TIMEOUT_MS).toBe(1000);
  });

  it("refuses the stand-in under NODE_ENV=production on a real production deployment", () => {
    expect(() =>
      parseEnv(newsApiEnvSchema, { ...BASE, EMBEDDINGS_PROVIDER: "stand-in", NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/EMBEDDINGS_PROVIDER: stand-in is refused on a production deployment/);
  });
});

describe("newsApiEnvSchema search cache and semantic cap", () => {
  const parse = (extra: Record<string, string> = {}) => parseEnv(newsApiEnvSchema, { ...BASE, ...extra } as unknown as NodeJS.ProcessEnv);
  it("defaults: 60 s, 500 entries, 32 MB, cap from CPU count (unset), queue 8, wait 250 ms", () => {
    const env = parse();
    expect([env.SEARCH_CACHE_TTL_SECONDS, env.SEARCH_CACHE_MAX_ENTRIES, env.SEARCH_CACHE_MAX_MB, env.SEARCH_SEMANTIC_MAX_CONCURRENT, env.SEARCH_SEMANTIC_QUEUE, env.SEARCH_SEMANTIC_QUEUE_WAIT_MS]).toEqual([60, 500, 32, undefined, 8, 250]);
  });
  it("accepts overrides, and 0 TTL to turn the cache off", () => {
    expect(parse({ SEARCH_CACHE_TTL_SECONDS: "0", SEARCH_SEMANTIC_MAX_CONCURRENT: "1", SEARCH_SEMANTIC_QUEUE: "0" })).toMatchObject({ SEARCH_CACHE_TTL_SECONDS: 0, SEARCH_SEMANTIC_MAX_CONCURRENT: 1, SEARCH_SEMANTIC_QUEUE: 0 });
  });
  it.each([
    ["SEARCH_CACHE_TTL_SECONDS", "-1"],
    ["SEARCH_CACHE_TTL_SECONDS", "3601"],
    ["SEARCH_CACHE_MAX_ENTRIES", "0"],
    ["SEARCH_CACHE_MAX_MB", "0"],
    ["SEARCH_SEMANTIC_MAX_CONCURRENT", "0"],
    ["SEARCH_SEMANTIC_QUEUE", "-1"],
    ["SEARCH_SEMANTIC_QUEUE_WAIT_MS", "5001"],
    ["SEARCH_CACHE_TTL_SECONDS", "abc"],
  ])("rejects %s=%s", (name, value) => {
    expect(() => parse({ [name]: value })).toThrow(new RegExp(`^Invalid environment: .*${name}`));
  });
});
