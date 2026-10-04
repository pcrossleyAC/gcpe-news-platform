import { describe, expect, it } from "vitest";
import { envFor, resolveSelfSubscribers, resolveSelfUrls, stackEnvSchema } from "./env";

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

  // Fix round 1, P2-R30 M6: ENTRA_TENANT_ID is shared (every app talks to the same Entra
  // tenant); AUTH_AUDIENCE stays per-app (each app is its own Entra audience/resource).
  it("shares ENTRA_TENANT_ID across every app but keeps AUTH_AUDIENCE per-prefix", () => {
    const env = { ENTRA_TENANT_ID: "tenant-1", CORE_AUTH_AUDIENCE: "aud-core", NRMS_AUTH_AUDIENCE: "aud-nrms" };
    expect(envFor(env, "CORE")).toEqual({ ENTRA_TENANT_ID: "tenant-1", AUTH_AUDIENCE: "aud-core" });
    expect(envFor(env, "NRMS")).toEqual({ ENTRA_TENANT_ID: "tenant-1", AUTH_AUDIENCE: "aud-nrms" });
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

  // Fix round 1, P2-R30 M1: only the `url` field is a candidate for rewriting — a `secret`
  // that happens to contain the literal text "self:/" must survive untouched. A blind
  // string-replace over the raw JSON text (the pre-fix implementation) would have rewritten
  // this secret too, corrupting the HMAC signature every delivery to this subscriber signs
  // with.
  it("never touches a secret (or any other field) that happens to contain the text self:/", () => {
    const raw = JSON.stringify([{ name: "a", url: "self:/events", secret: "contains-self:/-literally", types: ["*"] }]);
    const resolved = JSON.parse(resolveSelfSubscribers(raw, 9999)!);
    expect(resolved).toEqual([{ name: "a", url: "http://127.0.0.1:9999/events", secret: "contains-self:/-literally", types: ["*"] }]);
  });

  it("passes malformed JSON through unchanged, so parseSubscribers reports the real error", () => {
    const raw = "{not valid json";
    expect(resolveSelfSubscribers(raw, 1234)).toBe(raw);
  });
});

describe("resolveSelfUrls", () => {
  // Important fix 1 (P2-R30): self: resolution must apply to every app's EVENT_SUBSCRIBERS,
  // not just NRMS/NEWSAPI — Core publishing org.upserted to a self: News API URL dead-lettered
  // silently (an "unknown scheme" fetch failure, swallowed into dispatchOnce's per-row retry
  // accounting) before this fix.
  it("resolves EVENT_SUBSCRIBERS in any app's env view, not just NRMS/NEWSAPI", () => {
    const env = { EVENT_SUBSCRIBERS: JSON.stringify([{ name: "news-api", url: "self:/events", secret: "s", types: ["org.upserted"] }]) };
    const resolved = JSON.parse(resolveSelfUrls(env, 4000).EVENT_SUBSCRIBERS!);
    expect(resolved).toEqual([{ name: "news-api", url: "http://127.0.0.1:4000/events", secret: "s", types: ["org.upserted"] }]);
  });

  // M9: any OTHER *_URL var (not just EVENT_SUBSCRIBERS) whose whole value is self:/... —
  // e.g. News API's own NEWS_API_URL as seen by Public Site, or NoD's DISTRIBUTION_URL.
  it("resolves a plain self: URL on any var ending in _URL", () => {
    const env = { NEWS_API_URL: "self:/", DISTRIBUTION_URL: "self:/distribution", NOD_BASE_URL: "self:/nod" };
    expect(resolveSelfUrls(env, 5000)).toEqual({
      NEWS_API_URL: "http://127.0.0.1:5000/",
      DISTRIBUTION_URL: "http://127.0.0.1:5000/distribution",
      NOD_BASE_URL: "http://127.0.0.1:5000/nod",
    });
  });

  it("leaves a real external URL alone, including one ending in _URL that looks like a token endpoint", () => {
    const env = {
      PUBLIC_SITE_URL: "https://news.gov.bc.ca",
      DISTRIBUTION_TOKEN_URL: "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
    };
    expect(resolveSelfUrls(env, 5000)).toEqual(env);
  });

  it("leaves every other var (not ending in _URL, and not EVENT_SUBSCRIBERS) untouched", () => {
    const env = { DATABASE_URL_PREFIX: "not-a-url-var", PORT: "3001" };
    expect(resolveSelfUrls(env, 5000)).toEqual(env);
  });

  // Ruling P2-R32 (Task 14 re-review r1 residual): the *_URL heuristic also matched
  // <PREFIX>_DATABASE_URL — a self:/... DATABASE_URL would otherwise get silently rewritten
  // to an http://127.0.0.1:<port>/... URL and handed straight to pg, which fails loudly in
  // the best case (connection refused) and is simply the wrong fix in every case: a database
  // is never reached over the stack's own HTTP port. DATABASE_URL must never be set to
  // self:/ in the first place (see the env generator / runbook), so this is excluded from
  // rewriting entirely rather than "resolved" to something nonsensical.
  it("never rewrites a var whose name ends in DATABASE_URL, even one literally named DATABASE_URL", () => {
    const env = { CORE_DATABASE_URL: "self:/whatever", NRMS_DATABASE_URL: "self:/", DATABASE_URL: "self:/x" };
    expect(resolveSelfUrls(env, 5000)).toEqual(env);
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
