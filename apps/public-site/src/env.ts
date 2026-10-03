import { fileURLToPath } from "node:url";
import { z } from "zod";
import { eventSecretsSchema, loadTenantConfig, type TenantConfig } from "@gcpe/config";

export const defaultTenantConfigPath = fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url));

/**
 * TENANT_CONFIG's own schema. Parsed once by main.ts (to resolve the path to load before the
 * tenant config can inform SITE_NAME/PUBLIC_SITE_URL's defaults below) and then reused as-is
 * as the field in publicSiteEnvSchema, so main.ts never recomputes the default/override logic
 * by hand — the value used to load the tenant config is the same value parseEnv produces.
 */
export const tenantConfigPathSchema = z.string().default(defaultTenantConfigPath);

/**
 * Loads the tenant config at `tenantConfigPath`.
 *
 * If loading fails and TENANT_CONFIG was set explicitly (not just defaulted), that's a
 * configuration mistake worth failing fast and loudly for: swallowing it would silently run
 * with no SITE_NAME/PUBLIC_SITE_URL defaults and could mask a typo'd path.
 *
 * If TENANT_CONFIG was never set, a missing/invalid *default* tenant config is fine to fall
 * back from silently — SITE_NAME and PUBLIC_SITE_URL simply become required env vars instead
 * of defaulted ones (enforced by publicSiteEnvSchema below via parseEnv's normal "required"
 * error when they're actually missing — not silent, just not a tenant-config-specific error).
 */
export function resolveTenantConfig(opts: {
  tenantConfigPath: string;
  wasExplicit: boolean;
  load?: (path: string) => TenantConfig;
}): TenantConfig | undefined {
  const load = opts.load ?? loadTenantConfig;
  try {
    return load(opts.tenantConfigPath);
  } catch (err) {
    if (opts.wasExplicit) {
      throw new Error(`TENANT_CONFIG=${opts.tenantConfigPath} could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
    }
    return undefined;
  }
}

export function publicSiteEnvSchema(tenantConfig: TenantConfig | undefined) {
  return z.object({
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().default(3003),
    NEWS_API_URL: z.string().url(),
    OUTPUT_DIR: z.string().min(1),
    SITE_NAME: tenantConfig ? z.string().min(1).default(tenantConfig.siteName) : z.string().min(1),
    PUBLIC_SITE_URL: tenantConfig ? z.string().url().default(tenantConfig.publicSiteBaseUrl) : z.string().url(),
    EVENT_SECRETS: eventSecretsSchema,
    MIGRATIONS_FOLDER: z.string().default(fileURLToPath(new URL("../migrations", import.meta.url))),
    TENANT_CONFIG: tenantConfigPathSchema,
  });
}
