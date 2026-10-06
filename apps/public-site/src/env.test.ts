import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEnv, type TenantConfig } from "@gcpe/config";
import { defaultTenantConfigPath, publicSiteEnvSchema, resolveTenantConfig } from "./env";

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
  branding: { primaryColor: "#003366", logoUrl: null },
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
