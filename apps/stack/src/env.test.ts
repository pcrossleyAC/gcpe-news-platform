import { describe, expect, it } from "vitest";
import {
  APP_PREFIXES,
  envFor,
  FAKE_FLICKR,
  FAKE_FLICKR_ENV,
  internalEventEnv,
  INTERNAL_EVENT_ROUTES,
  resolveSelfSubscribers,
  resolveSelfUrls,
  routeSecret,
  sessionSecretFrom,
  stackEnvSchema,
  usesFakeFlickr,
} from "./env";

describe("envFor", () => {
  it("strips the app's own prefix off every <PREFIX>_VAR, leaving VAR", () => {
    const env = { NRMS_DATABASE_URL: "postgres://x/nrms", NRMS_PUBLISH_INTERVAL_MS: "1000" };
    expect(envFor(env, "NRMS")).toEqual({
      DATABASE_URL: "postgres://x/nrms",
      PUBLISH_INTERVAL_MS: "1000",
      NOD_URL: "self:/nod",
      DISTRIBUTION_URL: "self:/distribution",
      CORE_URL: "self:/core",
      ...FAKE_FLICKR_ENV,
    });
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
    expect(envFor(env, "NRMS")).toEqual({
      DATABASE_URL: "postgres://x/nrms",
      NOD_URL: "self:/nod",
      DISTRIBUTION_URL: "self:/distribution",
      CORE_URL: "self:/core",
      ...FAKE_FLICKR_ENV,
    });
  });

  it("doesn't confuse NOD_ with NODE_ENV (shared) or any other prefix's name as a substring", () => {
    const env = { NODE_ENV: "test", NOD_PORT: "3004" };
    expect(envFor(env, "NOD")).toEqual({ NODE_ENV: "test", PORT: "3004" });
  });

  it("ignores undefined values", () => {
    const env: NodeJS.ProcessEnv = { NRMS_DATABASE_URL: undefined, NRMS_PORT: "3006" };
    expect(envFor(env, "NRMS")).toEqual({
      PORT: "3006",
      NOD_URL: "self:/nod",
      DISTRIBUTION_URL: "self:/distribution",
      CORE_URL: "self:/core",
      ...FAKE_FLICKR_ENV,
    });
  });

  // Fix round 1, P2-R30 M6: ENTRA_TENANT_ID is shared (every app talks to the same Entra
  // tenant); AUTH_AUDIENCE stays per-app (each app is its own Entra audience/resource).
  it("shares ENTRA_TENANT_ID across every app but keeps AUTH_AUDIENCE per-prefix", () => {
    const env = { ENTRA_TENANT_ID: "tenant-1", CORE_AUTH_AUDIENCE: "aud-core", NRMS_AUTH_AUDIENCE: "aud-nrms" };
    expect(envFor(env, "CORE")).toEqual({ ENTRA_TENANT_ID: "tenant-1", AUTH_AUDIENCE: "aud-core" });
    expect(envFor(env, "NRMS")).toEqual({
      ENTRA_TENANT_ID: "tenant-1",
      AUTH_AUDIENCE: "aud-nrms",
      NOD_URL: "self:/nod",
      DISTRIBUTION_URL: "self:/distribution",
      CORE_URL: "self:/core",
      ...FAKE_FLICKR_ENV,
    });
  });

  // Task 9: NRMS needs NoD's and Distribution's in-process URLs to count subscribers and
  // schedule sends, but SiteGround's env form shouldn't need yet another pair of settings for
  // something that's always the same inside one stack — so these are built-in per-app
  // defaults, overridable by an explicit <PREFIX>_<VAR> like any other var.
  it("applies STACK_APP_DEFAULTS for an app that has them, overridable by an explicit prefixed var", () => {
    expect(envFor({}, "NRMS")).toMatchObject({ NOD_URL: "self:/nod", DISTRIBUTION_URL: "self:/distribution", CORE_URL: "self:/core" });
    expect(envFor({ NRMS_NOD_URL: "https://nod.example" }, "NRMS").NOD_URL).toBe("https://nod.example");
    expect(envFor({ NRMS_CORE_URL: "https://core.example" }, "NRMS").CORE_URL).toBe("https://core.example");
  });

  it("gives no defaults to an app that doesn't have any in STACK_APP_DEFAULTS", () => {
    expect(envFor({}, "CORE").NOD_URL).toBeUndefined();
  });

  // Plan 3d task 4: SITE_ENVIRONMENT (e.g. "test") reaches Public Site's isTestSite the same
  // way NODE_ENV/LOCAL_ADMIN_ALLOW_IN_PRODUCTION do, with no per-app SITE_SITE_ENVIRONMENT
  // setting needed.
  it("shares SITE_ENVIRONMENT across every app, like NODE_ENV", () => {
    const env = { SITE_ENVIRONMENT: "test", SITE_DATABASE_URL: "postgres://x/site" };
    expect(envFor(env, "SITE")).toMatchObject({ SITE_ENVIRONMENT: "test", DATABASE_URL: "postgres://x/site" });
    expect(envFor(env, "CORE").SITE_ENVIRONMENT).toBe("test");
  });
});

describe("resolveSelfSubscribers", () => {
  it("rewrites a self: subscriber URL to the loopback address at the actual port", () => {
    const raw = JSON.stringify([{ name: "news-api", url: "self:/events", secret: "s", types: ["release.published"] }]);
    const resolved = resolveSelfSubscribers(raw);
    expect(JSON.parse(resolved!)).toEqual([
      { name: "news-api", url: "http://stack.internal/events", secret: "s", types: ["release.published"] },
    ]);
  });

  it("rewrites every self: entry, not just the first", () => {
    const raw = JSON.stringify([
      { name: "a", url: "self:/one", secret: "s", types: ["*"] },
      { name: "b", url: "self:/two", secret: "s", types: ["*"] },
    ]);
    const resolved = resolveSelfSubscribers(raw);
    expect(JSON.parse(resolved!).map((s: { url: string }) => s.url)).toEqual(["http://stack.internal/one", "http://stack.internal/two"]);
  });

  it("leaves a non-self: subscriber URL untouched", () => {
    const raw = JSON.stringify([{ name: "ext", url: "https://example.com/events", secret: "s", types: ["*"] }]);
    expect(resolveSelfSubscribers(raw)).toBe(raw);
  });

  it("passes undefined through unchanged", () => {
    expect(resolveSelfSubscribers(undefined)).toBeUndefined();
  });

  // Fix round 1, P2-R30 M1: only the `url` field is a candidate for rewriting — a `secret`
  // that happens to contain the literal text "self:/" must survive untouched. A blind
  // string-replace over the raw JSON text (the pre-fix implementation) would have rewritten
  // this secret too, corrupting the HMAC signature every delivery to this subscriber signs
  // with.
  it("never touches a secret (or any other field) that happens to contain the text self:/", () => {
    const raw = JSON.stringify([{ name: "a", url: "self:/events", secret: "contains-self:/-literally", types: ["*"] }]);
    const resolved = JSON.parse(resolveSelfSubscribers(raw)!);
    expect(resolved).toEqual([{ name: "a", url: "http://stack.internal/events", secret: "contains-self:/-literally", types: ["*"] }]);
  });

  it("passes malformed JSON through unchanged, so parseSubscribers reports the real error", () => {
    const raw = "{not valid json";
    expect(resolveSelfSubscribers(raw)).toBe(raw);
  });
});

describe("resolveSelfUrls", () => {
  // Important fix 1 (P2-R30): self: resolution must apply to every app's EVENT_SUBSCRIBERS,
  // not just NRMS/NEWSAPI — Core publishing org.upserted to a self: News API URL dead-lettered
  // silently (an "unknown scheme" fetch failure, swallowed into dispatchOnce's per-row retry
  // accounting) before this fix.
  it("resolves EVENT_SUBSCRIBERS in any app's env view, not just NRMS/NEWSAPI", () => {
    const env = { EVENT_SUBSCRIBERS: JSON.stringify([{ name: "news-api", url: "self:/events", secret: "s", types: ["org.upserted"] }]) };
    const resolved = JSON.parse(resolveSelfUrls(env).EVENT_SUBSCRIBERS!);
    expect(resolved).toEqual([{ name: "news-api", url: "http://stack.internal/events", secret: "s", types: ["org.upserted"] }]);
  });

  // M9: any OTHER *_URL var (not just EVENT_SUBSCRIBERS) whose whole value is self:/... —
  // e.g. News API's own NEWS_API_URL as seen by Public Site, or NoD's DISTRIBUTION_URL.
  it("resolves a plain self: URL on any var ending in _URL", () => {
    const env = { NEWS_API_URL: "self:/", DISTRIBUTION_URL: "self:/distribution", NOD_BASE_URL: "self:/nod" };
    expect(resolveSelfUrls(env)).toEqual({
      NEWS_API_URL: "http://stack.internal/",
      DISTRIBUTION_URL: "http://stack.internal/distribution",
      NOD_BASE_URL: "http://stack.internal/nod",
    });
  });

  it("leaves a real external URL alone, including one ending in _URL that looks like a token endpoint", () => {
    const env = {
      PUBLIC_SITE_URL: "https://news.gov.bc.ca",
      DISTRIBUTION_TOKEN_URL: "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
    };
    expect(resolveSelfUrls(env)).toEqual(env);
  });

  it("leaves every other var (not ending in _URL, and not EVENT_SUBSCRIBERS) untouched", () => {
    const env = { DATABASE_URL_PREFIX: "not-a-url-var", PORT: "3001" };
    expect(resolveSelfUrls(env)).toEqual(env);
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
    expect(resolveSelfUrls(env)).toEqual(env);
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

// P2-R35: the internal event wiring is derived from one STACK_EVENT_SECRET.
describe("internalEventEnv / STACK_EVENT_SECRET", () => {
  const secret = "s".repeat(40);
  const parse = (v: string | undefined) => JSON.parse(v ?? "null");

  it("wires every sender to its receivers with matching per-route secrets", () => {
    const w = internalEventEnv(secret);
    const core = parse(w.CORE.EVENT_SUBSCRIBERS);
    const nrms = parse(w.NRMS.EVENT_SUBSCRIBERS);
    const newsApiSubs = parse(w.NEWSAPI.EVENT_SUBSCRIBERS);
    expect(core).toEqual([
      { name: "news-api", url: "self:/events", secret: expect.any(String), types: ["*"] },
      {
        name: "nrms",
        url: "self:/nrms/events",
        secret: expect.any(String),
        types: ["org.upserted", "org.deactivated", "sector.upserted", "sector.deactivated", "theme.upserted", "theme.deactivated", "tag.upserted", "tag.deactivated"],
      },
    ]);
    expect(nrms.map((s: { name: string; types: string[] }) => [s.name, s.types])).toEqual([["news-api", ["*"]], ["nod", ["release.published"]]]);
    expect(newsApiSubs).toEqual([{ name: "public-site", url: "self:/site-builder/events", secret: expect.any(String), types: ["site.rebuild_requested"] }]);
    // Receivers hold exactly the secret their sender signs with, keyed by the sender's source name.
    expect(parse(w.NEWSAPI.EVENT_SECRETS)).toEqual({ core: core[0].secret, nrms: nrms[0].secret });
    expect(parse(w.NOD.EVENT_SECRETS)).toEqual({ nrms: nrms[1].secret });
    expect(parse(w.SITE.EVENT_SECRETS)).toEqual({ "news-api": newsApiSubs[0].secret });
    expect(w.DIST).toEqual({});
  });

  it("derives a distinct secret per route, none equal to the stack secret, deterministically", () => {
    const all = INTERNAL_EVENT_ROUTES.map((r) => routeSecret(secret, r));
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain(secret);
    expect(INTERNAL_EVENT_ROUTES.map((r) => routeSecret(secret, r))).toEqual(all);
    expect(routeSecret("t".repeat(40), INTERNAL_EVENT_ROUTES[0])).not.toBe(all[0]);
  });

  it("envFor fills EVENT_* from STACK_EVENT_SECRET, lets explicit <PREFIX>_EVENT_* win, and never leaks the stack secret", () => {
    const derived = envFor({ STACK_EVENT_SECRET: secret }, "NRMS");
    expect(parse(derived.EVENT_SUBSCRIBERS)).toHaveLength(2);
    expect(Object.values(derived)).not.toContain(secret);
    const explicit = envFor({ STACK_EVENT_SECRET: secret, NRMS_EVENT_SUBSCRIBERS: "[]" }, "NRMS");
    expect(explicit.EVENT_SUBSCRIBERS).toBe("[]");
    expect(envFor({}, "NRMS").EVENT_SUBSCRIBERS).toBeUndefined();
  });

  it("rejects a short STACK_EVENT_SECRET at startup", () => {
    expect(stackEnvSchema.safeParse({ TICK_TOKEN: "x".repeat(32), STACK_EVENT_SECRET: "short" }).success).toBe(false);
  });
});

describe("SESSION_SECRET for the stack", () => {
  const stackSecret = "e".repeat(40);

  it("derives one session secret for every app from STACK_EVENT_SECRET", () => {
    const derived = sessionSecretFrom(stackSecret);
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
    for (const p of APP_PREFIXES) expect(envFor({ STACK_EVENT_SECRET: stackSecret }, p).SESSION_SECRET).toBe(derived);
    for (const route of INTERNAL_EVENT_ROUTES) expect(routeSecret(stackSecret, route)).not.toBe(derived);
  });

  it("an explicit SESSION_SECRET and SESSION_COOKIE_SECURE are shared as-is", () => {
    const view = envFor({ STACK_EVENT_SECRET: stackSecret, SESSION_SECRET: "x".repeat(40), SESSION_COOKIE_SECURE: "false" }, "NRMS");
    expect(view.SESSION_SECRET).toBe("x".repeat(40));
    expect(view.SESSION_COOKIE_SECURE).toBe("false");
  });

  it("no STACK_EVENT_SECRET and no SESSION_SECRET means no session secret", () => {
    expect(envFor({}, "CORE").SESSION_SECRET).toBeUndefined();
  });
});

describe("persistent data dir in env views", () => {
  it("resolves a relative SITE_OUTPUT_DIR under the data dir and defaults NRMS STORAGE_DIR", () => {
    expect(envFor({ SITE_OUTPUT_DIR: "./site-output" }, "SITE", "/data").OUTPUT_DIR).toBe("/data/site-output");
    expect(envFor({ SITE_OUTPUT_DIR: "/abs/out" }, "SITE", "/data").OUTPUT_DIR).toBe("/abs/out");
    expect(envFor({}, "NRMS", "/data").STORAGE_DIR).toBe("/data/storage");
    expect(envFor({ NRMS_STORAGE_DIR: "/x" }, "NRMS", "/data").STORAGE_DIR).toBe("/x");
    expect(envFor({}, "CORE", "/data").STORAGE_DIR).toBeUndefined();
  });
});

describe("Core → NRMS taxonomy route", () => {
  it("sends Core's org and category events to NRMS, signed with their own pair secret", () => {
    const wiring = internalEventEnv("e".repeat(40));
    const coreSubs = JSON.parse(wiring.CORE.EVENT_SUBSCRIBERS!) as { name: string; url: string; types: string[] }[];
    const toNrms = coreSubs.find((s) => s.name === "nrms")!;
    expect(toNrms.url).toBe("self:/nrms/events");
    expect(toNrms.types).toEqual(["org.upserted", "org.deactivated", "sector.upserted", "sector.deactivated", "theme.upserted", "theme.deactivated", "tag.upserted", "tag.deactivated"]);
    expect(Object.keys(JSON.parse(wiring.NRMS.EVENT_SECRETS!))).toEqual(["core"]);
  });
});

describe("Flickr in the stack", () => {
  it("with no FLICKR_API_KEY anywhere, NRMS is pointed at the in-stack fake with its fixed test credentials", () => {
    const view = envFor({ NRMS_FLICKR_ALERT_EMAILS: "ops@gov.bc.ca" }, "NRMS");
    expect(view).toMatchObject({
      FLICKR_MODE: "fake",
      FLICKR_API_KEY: "fake-key",
      FLICKR_API_SECRET: "fake-secret-0123456789",
      FLICKR_ACCESS_TOKEN: "fake-token",
      FLICKR_ACCESS_SECRET: "fake-token-secret-0123456789",
      FLICKR_REST_URL: "self:/fake-flickr/services/rest",
      FLICKR_OEMBED_URL: "self:/fake-flickr/services/oembed",
      FLICKR_OAUTH_URL: "self:/fake-flickr/services/oauth",
      FLICKR_ALERT_EMAILS: "ops@gov.bc.ca",
    });
    expect(FAKE_FLICKR).toEqual({ apiKey: "fake-key", apiSecret: "fake-secret-0123456789", accessToken: "fake-token", accessSecret: "fake-token-secret-0123456789" });
    expect(resolveSelfUrls(view)).toMatchObject({
      FLICKR_REST_URL: "http://stack.internal/fake-flickr/services/rest",
      FLICKR_OEMBED_URL: "http://stack.internal/fake-flickr/services/oembed",
      FLICKR_OAUTH_URL: "http://stack.internal/fake-flickr/services/oauth",
    });
    expect(usesFakeFlickr({})).toBe(true);
    expect(usesFakeFlickr({ NRMS_FLICKR_API_KEY: "" })).toBe(true);
  });

  it("an NRMS_FLICKR_API_KEY means the real Flickr: nothing of the fake is set", () => {
    const view = envFor({ NRMS_FLICKR_API_KEY: "real-key", NRMS_FLICKR_API_SECRET: "real-secret" }, "NRMS");
    expect(view.FLICKR_API_KEY).toBe("real-key");
    expect(view.FLICKR_API_SECRET).toBe("real-secret");
    expect(view.FLICKR_MODE).toBeUndefined();
    expect(view.FLICKR_REST_URL).toBeUndefined();
    expect(usesFakeFlickr({ NRMS_FLICKR_API_KEY: "real-key" })).toBe(false);
  });

  it("an unprefixed (shared) FLICKR_* reaches NRMS only, and an NRMS_FLICKR_* still wins", () => {
    const env = { FLICKR_API_KEY: "shared-key", FLICKR_API_SECRET: "shared-secret", NRMS_FLICKR_API_SECRET: "nrms-secret" };
    expect(usesFakeFlickr(env)).toBe(false);
    const view = envFor(env, "NRMS");
    expect(view).toMatchObject({ FLICKR_API_KEY: "shared-key", FLICKR_API_SECRET: "nrms-secret" });
    expect(view.FLICKR_MODE).toBeUndefined();
    for (const p of APP_PREFIXES.filter((x) => x !== "NRMS")) {
      expect(Object.keys(envFor(env, p)).filter((k) => k.startsWith("FLICKR_")), p).toEqual([]);
    }
  });
});

describe("when the stack uses the fake Flickr (fix round 1: never silently in production)", () => {
  const prod = { NODE_ENV: "production" };

  it("production with no key and no override: no fake — NRMS gets no Flickr config and reports unavailable", () => {
    expect(usesFakeFlickr(prod)).toBe(false);
    const view = envFor(prod, "NRMS");
    expect(Object.keys(view).filter((k) => k.startsWith("FLICKR_"))).toEqual([]);
  });

  it("production + LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true (a test deployment) → fake", () => {
    const env = { ...prod, LOCAL_ADMIN_ALLOW_IN_PRODUCTION: "true" };
    expect(usesFakeFlickr(env)).toBe(true);
    expect(envFor(env, "NRMS")).toMatchObject(FAKE_FLICKR_ENV);
    expect(usesFakeFlickr({ ...prod, LOCAL_ADMIN_ALLOW_IN_PRODUCTION: "false" })).toBe(false);
  });

  it("an explicit FLICKR_MODE=fake (shared or NRMS-prefixed) → fake, even in production", () => {
    expect(usesFakeFlickr({ ...prod, FLICKR_MODE: "fake" })).toBe(true);
    expect(usesFakeFlickr({ ...prod, NRMS_FLICKR_MODE: "fake" })).toBe(true);
    expect(envFor({ ...prod, NRMS_FLICKR_MODE: "fake" }, "NRMS")).toMatchObject(FAKE_FLICKR_ENV);
    // The prefixed setting wins over the shared one, as it does in envFor.
    expect(usesFakeFlickr({ ...prod, FLICKR_MODE: "fake", NRMS_FLICKR_MODE: "real" })).toBe(false);
  });

  it("not production → fake when there is no key", () => {
    expect(usesFakeFlickr({})).toBe(true);
    expect(usesFakeFlickr({ NODE_ENV: "test" })).toBe(true);
  });

  it("a key present never means the fake, whatever else is set", () => {
    for (const extra of [{}, { NODE_ENV: "test" }, { LOCAL_ADMIN_ALLOW_IN_PRODUCTION: "true" }, { FLICKR_MODE: "fake" }, { NRMS_FLICKR_MODE: "fake" }]) {
      expect(usesFakeFlickr({ ...extra, NRMS_FLICKR_API_KEY: "k" })).toBe(false);
      expect(usesFakeFlickr({ ...extra, FLICKR_API_KEY: "k" })).toBe(false);
      expect(envFor({ ...extra, FLICKR_API_KEY: "k" }, "NRMS").FLICKR_REST_URL).toBeUndefined();
    }
  });

  it("the effective key is the prefixed one when it is defined, else the shared one", () => {
    // An emptied NRMS_FLICKR_API_KEY overrides a shared key in NRMS's view ("" = unset), so it means no key here too.
    expect(envFor({ FLICKR_API_KEY: "shared", NRMS_FLICKR_API_KEY: "" }, "NRMS").FLICKR_API_KEY).not.toBe("shared");
    expect(usesFakeFlickr({ FLICKR_API_KEY: "shared", NRMS_FLICKR_API_KEY: "" })).toBe(true);
    expect(usesFakeFlickr({ ...prod, FLICKR_API_KEY: "shared", NRMS_FLICKR_API_KEY: "" })).toBe(false);
    expect(usesFakeFlickr({ ...prod, FLICKR_API_KEY: "shared" })).toBe(false);
  });
});
