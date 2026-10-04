import { describe, expect, it } from "vitest";
import { envFor, resolveSelfSubscribers, stackEnvSchema } from "./env";

describe("envFor", () => {
  it("strips the app's own prefix off every <PREFIX>_VAR, leaving VAR", () => {
    const env = { NRMS_DATABASE_URL: "postgres://x/nrms", NRMS_PUBLISH_INTERVAL_MS: "1000" };
    expect(envFor(env, "NRMS")).toEqual({ DATABASE_URL: "postgres://x/nrms", PUBLISH_INTERVAL_MS: "1000" });
  });

  it("passes shared vars (LOCAL_ADMIN_*, LOCAL_AUTH_SECRET, TENANT_CONFIG, NODE_ENV) through to every app untouched", () => {
    const env = {
      NODE_ENV: "production",
      TENANT_CONFIG: "/x/bc.json",
      LOCAL_AUTH_SECRET: "s".repeat(32),
      LOCAL_ADMIN_ENABLED: "true",
      LOCAL_ADMIN_USERNAME: "admin",
      CORE_DATABASE_URL: "postgres://x/core",
    };
    expect(envFor(env, "CORE")).toEqual({
      NODE_ENV: "production",
      TENANT_CONFIG: "/x/bc.json",
      LOCAL_AUTH_SECRET: "s".repeat(32),
      LOCAL_ADMIN_ENABLED: "true",
      LOCAL_ADMIN_USERNAME: "admin",
      DATABASE_URL: "postgres://x/core",
    });
  });

  it("never leaks another app's prefixed vars into this app's view", () => {
    const env = { NRMS_DATABASE_URL: "postgres://x/nrms", NOD_DATABASE_URL: "postgres://x/nod" };
    expect(envFor(env, "NRMS")).toEqual({ DATABASE_URL: "postgres://x/nrms" });
  });

  it("doesn't confuse NOD_ with NODE_ENV (shared) or any other prefix's name as a substring", () => {
    const env = { NODE_ENV: "test", NOD_PORT: "3004" };
    expect(envFor(env, "NOD")).toEqual({ NODE_ENV: "test", PORT: "3004" });
  });

  it("ignores undefined values", () => {
    const env: NodeJS.ProcessEnv = { NRMS_DATABASE_URL: undefined, NRMS_PORT: "3006" };
    expect(envFor(env, "NRMS")).toEqual({ PORT: "3006" });
  });
});

describe("resolveSelfSubscribers", () => {
  it("rewrites a self: subscriber URL to the loopback address at the actual port", () => {
    const raw = JSON.stringify([{ name: "news-api", url: "self:/events", secret: "s", types: ["release.published"] }]);
    const resolved = resolveSelfSubscribers(raw, 54321);
    expect(JSON.parse(resolved!)).toEqual([
      { name: "news-api", url: "http://127.0.0.1:54321/events", secret: "s", types: ["release.published"] },
    ]);
  });

  it("rewrites every self: entry, not just the first", () => {
    const raw = JSON.stringify([
      { name: "a", url: "self:/one", secret: "s", types: ["*"] },
      { name: "b", url: "self:/two", secret: "s", types: ["*"] },
    ]);
    const resolved = resolveSelfSubscribers(raw, 1234);
    expect(JSON.parse(resolved!).map((s: { url: string }) => s.url)).toEqual(["http://127.0.0.1:1234/one", "http://127.0.0.1:1234/two"]);
  });

  it("leaves a non-self: subscriber URL untouched", () => {
    const raw = JSON.stringify([{ name: "ext", url: "https://example.com/events", secret: "s", types: ["*"] }]);
    expect(resolveSelfSubscribers(raw, 1234)).toBe(raw);
  });

  it("passes undefined through unchanged", () => {
    expect(resolveSelfSubscribers(undefined, 1234)).toBeUndefined();
  });
});

describe("stackEnvSchema", () => {
  it("requires TICK_TOKEN to be at least 32 characters", () => {
    const result = stackEnvSchema.safeParse({ TICK_TOKEN: "short" });
    expect(result.success).toBe(false);
  });

  it("defaults STACK_LOOPS to true and UPDATES_HUB_ENABLED to false", () => {
    const result = stackEnvSchema.parse({ TICK_TOKEN: "t".repeat(32) });
    expect(result.STACK_LOOPS).toBe(true);
    expect(result.UPDATES_HUB_ENABLED).toBe(false);
  });

  it("parses STACK_LOOPS=false and UPDATES_HUB_ENABLED=true", () => {
    const result = stackEnvSchema.parse({ TICK_TOKEN: "t".repeat(32), STACK_LOOPS: "false", UPDATES_HUB_ENABLED: "true" });
    expect(result.STACK_LOOPS).toBe(false);
    expect(result.UPDATES_HUB_ENABLED).toBe(true);
  });
});
