import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashPassword, serviceTokenProvider } from "@gcpe/auth";
import { parseEnv, type TenantConfig } from "@gcpe/config";
import { defaultSiteAssetsDir, defaultTenantConfigPath, newsApiTokenOptions, publicSiteEnvSchema, resolveTenantConfig } from "./env";

const BASE = {
  DATABASE_URL: "postgres://localhost:5432/public_site",
  NEWS_API_URL: "http://localhost:3002",
  OUTPUT_DIR: "/tmp/site",
};

const tenant: TenantConfig = {
  tenantId: "bc",
  siteName: "BC Gov News",
  timeZone: "America/Vancouver",
  defaultLanguageId: 4105,
  organizationLabel: { singular: "Ministry", plural: "Ministries" },
  publicSiteBaseUrl: "https://news.gov.bc.ca",
  features: { semanticSearch: false, staffAi: false },
  search: { language: "english" },
  site: {
    theme: {
      colors: {
        primary: "#013366", primaryText: "#FFFFFF", accent: "#FCBA19", text: "#2D2D2D",
        mutedText: "#474543", surface: "#F2F2F2", background: "#FFFFFF", border: "#D8D8D8",
      },
      font: { family: "BC Sans", fallback: "Verdana, Arial, sans-serif" },
      logo: { path: "assets/bc-logo.svg", alt: "Government of British Columbia" },
      footerLinks: [],
    },
  },
};

describe("resolveTenantConfig", () => {
  it("returns the loaded config when loading succeeds", () => {
    const result = resolveTenantConfig({ tenantConfigPath: "/any/path.json", wasExplicit: false, load: () => tenant });
    expect(result).toEqual(tenant);
  });

  // Fix round 1, item 7: an explicitly-set TENANT_CONFIG that fails to load used to be
  // swallowed silently, same as an unset/defaulted one.
  it("fails fast with a clear error when TENANT_CONFIG was set explicitly and loading fails", () => {
    expect(() =>
      resolveTenantConfig({
        tenantConfigPath: "/explicit/path.json",
        wasExplicit: true,
        load: () => {
          throw new Error("ENOENT: no such file");
        },
      }),
    ).toThrow(/TENANT_CONFIG=\/explicit\/path\.json.*ENOENT/);
  });

  it("falls back silently (returns undefined, no throw) when TENANT_CONFIG was never set and loading fails", () => {
    const result = resolveTenantConfig({
      tenantConfigPath: "/default/path.json",
      wasExplicit: false,
      load: () => {
        throw new Error("ENOENT: no such file");
      },
    });
    expect(result).toBeUndefined();
  });
});

describe("publicSiteEnvSchema", () => {
  it("defaults SITE_NAME and PUBLIC_SITE_URL from the tenant config when one is loaded", () => {
    const env = parseEnv(publicSiteEnvSchema(tenant), BASE as unknown as NodeJS.ProcessEnv);
    expect(env.SITE_NAME).toBe("BC Gov News");
    expect(env.PUBLIC_SITE_URL).toBe("https://news.gov.bc.ca");
  });

  it("lets SITE_NAME/PUBLIC_SITE_URL env vars override the tenant config defaults", () => {
    const env = parseEnv(
      publicSiteEnvSchema(tenant),
      { ...BASE, SITE_NAME: "Override", PUBLIC_SITE_URL: "https://override.example" } as unknown as NodeJS.ProcessEnv,
    );
    expect(env.SITE_NAME).toBe("Override");
    expect(env.PUBLIC_SITE_URL).toBe("https://override.example");
  });

  // Fix round 1, item 7: without a tenant config to fall back on, SITE_NAME/PUBLIC_SITE_URL
  // must be required, not silently left undefined.
  it("requires SITE_NAME and PUBLIC_SITE_URL when no tenant config is available", () => {
    expect(() => parseEnv(publicSiteEnvSchema(undefined), BASE as unknown as NodeJS.ProcessEnv)).toThrow(/SITE_NAME.*PUBLIC_SITE_URL|PUBLIC_SITE_URL.*SITE_NAME/);
  });

  it("accepts SITE_NAME/PUBLIC_SITE_URL from env with no tenant config", () => {
    const env = parseEnv(
      publicSiteEnvSchema(undefined),
      { ...BASE, SITE_NAME: "No Tenant", PUBLIC_SITE_URL: "https://no-tenant.example" } as unknown as NodeJS.ProcessEnv,
    );
    expect(env.SITE_NAME).toBe("No Tenant");
    expect(env.PUBLIC_SITE_URL).toBe("https://no-tenant.example");
  });
});

describe("defaultTenantConfigPath", () => {
  it("resolves to a real file on disk (the repo's bc tenant config)", () => {
    expect(() => readFileSync(defaultTenantConfigPath, "utf8")).not.toThrow();
  });
});

describe("SITE_ASSETS_DIR", () => {
  it("defaults to the repo's config/site folder when unset", () => {
    const env = parseEnv(publicSiteEnvSchema(undefined), { ...BASE, SITE_NAME: "N", PUBLIC_SITE_URL: "https://n.example" } as unknown as NodeJS.ProcessEnv);
    expect(env.SITE_ASSETS_DIR).toBe(defaultSiteAssetsDir);
  });

  it("uses the given value when set", () => {
    const env = parseEnv(
      publicSiteEnvSchema(undefined),
      { ...BASE, SITE_NAME: "N", PUBLIC_SITE_URL: "https://n.example", SITE_ASSETS_DIR: "/custom/assets" } as unknown as NodeJS.ProcessEnv,
    );
    expect(env.SITE_ASSETS_DIR).toBe("/custom/assets");
  });
});

describe("SITE_REBUILD_BATCH", () => {
  const withSite = { ...BASE, SITE_NAME: "N", PUBLIC_SITE_URL: "https://n.example" };

  it("defaults to 200", () => {
    const env = parseEnv(publicSiteEnvSchema(undefined), withSite as unknown as NodeJS.ProcessEnv);
    expect(env.SITE_REBUILD_BATCH).toBe(200);
  });

  it("accepts the bounds (1 and 1000)", () => {
    expect(parseEnv(publicSiteEnvSchema(undefined), { ...withSite, SITE_REBUILD_BATCH: "1" } as unknown as NodeJS.ProcessEnv).SITE_REBUILD_BATCH).toBe(1);
    expect(parseEnv(publicSiteEnvSchema(undefined), { ...withSite, SITE_REBUILD_BATCH: "1000" } as unknown as NodeJS.ProcessEnv).SITE_REBUILD_BATCH).toBe(1000);
  });

  it("rejects a value outside the bounds", () => {
    expect(() => parseEnv(publicSiteEnvSchema(undefined), { ...withSite, SITE_REBUILD_BATCH: "0" } as unknown as NodeJS.ProcessEnv)).toThrow();
    expect(() => parseEnv(publicSiteEnvSchema(undefined), { ...withSite, SITE_REBUILD_BATCH: "1001" } as unknown as NodeJS.ProcessEnv)).toThrow();
  });
});

describe("SYNC_INTERVAL_MS", () => {
  const withSite = { ...BASE, SITE_NAME: "N", PUBLIC_SITE_URL: "https://n.example" };

  it("defaults to 30000", () => {
    const env = parseEnv(publicSiteEnvSchema(undefined), withSite as unknown as NodeJS.ProcessEnv);
    expect(env.SYNC_INTERVAL_MS).toBe(30_000);
  });

  it("accepts the lower bound (1000)", () => {
    const env = parseEnv(publicSiteEnvSchema(undefined), { ...withSite, SYNC_INTERVAL_MS: "1000" } as unknown as NodeJS.ProcessEnv);
    expect(env.SYNC_INTERVAL_MS).toBe(1000);
  });

  it("rejects a value below the bound", () => {
    expect(() => parseEnv(publicSiteEnvSchema(undefined), { ...withSite, SYNC_INTERVAL_MS: "999" } as unknown as NodeJS.ProcessEnv)).toThrow();
  });
});

describe("NEWS_API_TOKEN_URL/CLIENT_ID/CLIENT_SECRET/SCOPE", () => {
  const withSite = { ...BASE, SITE_NAME: "N", PUBLIC_SITE_URL: "https://n.example" };

  it("are optional and unset by default", () => {
    const env = parseEnv(publicSiteEnvSchema(undefined), withSite as unknown as NodeJS.ProcessEnv);
    expect(env.NEWS_API_TOKEN_URL).toBeUndefined();
    expect(env.NEWS_API_CLIENT_ID).toBeUndefined();
    expect(env.NEWS_API_CLIENT_SECRET).toBeUndefined();
    expect(env.NEWS_API_SCOPE).toBeUndefined();
  });

  it("an empty string is treated as unset", () => {
    const env = parseEnv(
      publicSiteEnvSchema(undefined),
      { ...withSite, NEWS_API_TOKEN_URL: "", NEWS_API_CLIENT_ID: "", NEWS_API_CLIENT_SECRET: "", NEWS_API_SCOPE: "" } as unknown as NodeJS.ProcessEnv,
    );
    expect(env.NEWS_API_TOKEN_URL).toBeUndefined();
    expect(env.NEWS_API_CLIENT_ID).toBeUndefined();
    expect(env.NEWS_API_CLIENT_SECRET).toBeUndefined();
    expect(env.NEWS_API_SCOPE).toBeUndefined();
  });

  it("are set from env when given", () => {
    const env = parseEnv(
      publicSiteEnvSchema(undefined),
      { ...withSite, NEWS_API_TOKEN_URL: "https://entra.example/token", NEWS_API_CLIENT_ID: "cid", NEWS_API_CLIENT_SECRET: "secret", NEWS_API_SCOPE: "scope" } as unknown as NodeJS.ProcessEnv,
    );
    expect(env.NEWS_API_TOKEN_URL).toBe("https://entra.example/token");
    expect(env.NEWS_API_CLIENT_ID).toBe("cid");
    expect(env.NEWS_API_CLIENT_SECRET).toBe("secret");
    expect(env.NEWS_API_SCOPE).toBe("scope");
  });
});

describe("SEARCH_API_URL", () => {
  const withSite = { ...BASE, SITE_NAME: "N", PUBLIC_SITE_URL: "https://n.example" };

  it("is optional and unset by default", () => {
    const env = parseEnv(publicSiteEnvSchema(undefined), withSite as unknown as NodeJS.ProcessEnv);
    expect(env.SEARCH_API_URL).toBeUndefined();
  });

  it("is set from env when given", () => {
    const env = parseEnv(publicSiteEnvSchema(undefined), { ...withSite, SEARCH_API_URL: "https://api.example" } as unknown as NodeJS.ProcessEnv);
    expect(env.SEARCH_API_URL).toBe("https://api.example");
  });

  it("rejects a non-URL value", () => {
    expect(() => parseEnv(publicSiteEnvSchema(undefined), { ...withSite, SEARCH_API_URL: "not-a-url" } as unknown as NodeJS.ProcessEnv)).toThrow();
  });

  // An emptied SiteGround field (clearing a once-set value) sends "" , not a missing key — must
  // not fail z.string().url()'s own validation, which would stop the whole public site starting.
  it("treats an emptied value the same as unset", () => {
    const env = parseEnv(publicSiteEnvSchema(undefined), { ...withSite, SEARCH_API_URL: "" } as unknown as NodeJS.ProcessEnv);
    expect(env.SEARCH_API_URL).toBeUndefined();
  });
});

describe("newsApiTokenOptions", () => {
  const entraParsed = {
    NEWS_API_TOKEN_URL: "https://entra.example/token",
    NEWS_API_CLIENT_ID: "cid",
    NEWS_API_CLIENT_SECRET: "secret",
    NEWS_API_SCOPE: "scope",
  };
  const noEntraParsed = { NEWS_API_TOKEN_URL: undefined, NEWS_API_CLIENT_ID: undefined, NEWS_API_CLIENT_SECRET: undefined, NEWS_API_SCOPE: undefined };

  it("with all four Entra fields: tokenUrl/clientId/clientSecret/scope set, subject site-builder, roles NewsApi.ChangesRead, envPrefix NEWS_API", () => {
    const opts = newsApiTokenOptions(entraParsed, {});
    expect(opts).toMatchObject({
      tokenUrl: "https://entra.example/token",
      clientId: "cid",
      clientSecret: "secret",
      scope: "scope",
      subject: "site-builder",
      roles: ["NewsApi.ChangesRead"],
      envPrefix: "NEWS_API",
    });
  });

  it("LOCAL_ADMIN_ENABLED=true with a valid hash and secret plus a shared ENTRA_TENANT_ID (no AUTH_AUDIENCE) sets local, without throwing", async () => {
    const hash = await hashPassword("fixture-password-for-env-tests");
    const env = {
      LOCAL_ADMIN_ENABLED: "true",
      LOCAL_ADMIN_PASSWORD_HASH: hash,
      LOCAL_AUTH_SECRET: "x".repeat(32),
      ENTRA_TENANT_ID: "shared-tenant",
    };
    const opts = newsApiTokenOptions(noEntraParsed, env);
    expect(opts.local).not.toBeNull();
    expect(opts.local?.secret).toBe("x".repeat(32));
  });

  it("with neither Entra nor local admin configured: local is null, and serviceTokenProvider throws mentioning NEWS_API_TOKEN_URL", () => {
    const opts = newsApiTokenOptions(noEntraParsed, {});
    expect(opts.local).toBeNull();
    expect(() => serviceTokenProvider(opts)).toThrow(/NEWS_API_TOKEN_URL/);
  });
});

describe("Google Search Console verification env", () => {
  const parse = (extra: Record<string, string>) => parseEnv(publicSiteEnvSchema(tenant), { ...BASE, ...extra });
  it("accepts valid values, and unset or empty means none", () => {
    const ok = parse({ GOOGLE_VERIFICATION_FILE: "google790b0529c8dcfaff.html", GOOGLE_SITE_VERIFICATION: "ss-eO0gSqB1_GY5aWryEXVmGQBHJgpe9-hdwcskzjss" });
    expect(ok.GOOGLE_VERIFICATION_FILE).toBe("google790b0529c8dcfaff.html");
    expect(ok.GOOGLE_SITE_VERIFICATION).toBe("ss-eO0gSqB1_GY5aWryEXVmGQBHJgpe9-hdwcskzjss");
    expect(parse({}).GOOGLE_VERIFICATION_FILE).toBeUndefined();
    expect(parse({ GOOGLE_VERIFICATION_FILE: "", GOOGLE_SITE_VERIFICATION: "" }).GOOGLE_SITE_VERIFICATION).toBeUndefined();
  });
  it("env rejects GOOGLE_VERIFICATION_FILE='../x.html' and a meta value with a quote", () => {
    for (const bad of ["../x.html", "google790b0529c8dcfaff.html/../a", "google790b0529c8dcfaf.html", "google790b0529c8dcfaff.html\n"]) {
      expect(() => parse({ GOOGLE_VERIFICATION_FILE: bad }), bad).toThrow();
    }
    for (const bad of ['abcdefghij0123456789"', 'abcdefghij0123456789"><script>', "short", "a".repeat(101), "abcdefghij 0123456789"]) {
      expect(() => parse({ GOOGLE_SITE_VERIFICATION: bad }), bad).toThrow();
    }
  });
});
