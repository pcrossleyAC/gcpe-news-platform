import { fileURLToPath } from "node:url";
import { z } from "zod";
import { authFromEnv, NEWS_API_CHANGES_ROLE, type LocalAuthConfig, type ServiceTokenOptions } from "@gcpe/auth";
import { eventSecretsSchema, loadTenantConfig, type TenantConfig } from "@gcpe/config";
import { GOOGLE_SITE_VERIFICATION_RE, GOOGLE_VERIFICATION_FILE_RE } from "./verification";

/** An optional setting where "" (an emptied SiteGround field) means unset — NRMS's own
 * `optionalSetting` (apps/nrms/src/start.ts), duplicated rather than imported: apps never
 * import another app's src, only shared packages. */
const optionalSetting = z
  .string()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

export const defaultTenantConfigPath = fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url));
export const defaultSiteAssetsDir = fileURLToPath(new URL("../../../config/site", import.meta.url));

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
    SITE_ASSETS_DIR: z.string().min(1).default(defaultSiteAssetsDir),
    /** Pages drained per tick/run (spec §6.2). */
    SITE_REBUILD_BATCH: z.coerce.number().int().min(1).max(1000).default(200),
    /** The standalone loop's interval (main.ts); the stack ticks instead (apps/stack/src/stack.ts). */
    SYNC_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
    // The site builder's own service token for GET /api/v2/changes (spec §5.4): Entra client
    // credentials, all four or none (newsApiTokenOptions below), with a local-admin-token
    // fallback on a test deployment. "" (an emptied SiteGround field) is treated as unset.
    NEWS_API_TOKEN_URL: optionalSetting.pipe(z.string().url().optional()),
    NEWS_API_CLIENT_ID: optionalSetting,
    NEWS_API_CLIENT_SECRET: optionalSetting,
    NEWS_API_SCOPE: optionalSetting,
    /** The search page's `/api/v2/search` host, when it isn't the site's own origin (Q81).
     * Unset on the stack and on a single-host deployment: the page calls its own origin. "" (an
     * emptied SiteGround field, e.g. clearing a once-set value) is treated as unset, like every
     * other optional setting in this file. */
    SEARCH_API_URL: optionalSetting.pipe(z.string().url().optional()),
    /** Google Search Console verification (url-compat §1d): the HTML file's name, written to the
     * site root. Token-shaped so it can never be a path. "" is unset. */
    GOOGLE_VERIFICATION_FILE: optionalSetting.pipe(z.string().regex(GOOGLE_VERIFICATION_FILE_RE, "must look like google<16 hex>.html").optional()),
    /** The verification meta tag's content (home page head). Token-shaped so it can never carry markup. "" is unset. */
    GOOGLE_SITE_VERIFICATION: optionalSetting.pipe(z.string().regex(GOOGLE_SITE_VERIFICATION_RE, "must be 20-100 letters, digits, - or _").optional()),
  });
}

/**
 * The site builder's token for GET /api/v2/changes (spec §5.4): Entra client credentials when
 * NEWS_API_TOKEN_URL/CLIENT_ID/CLIENT_SECRET/SCOPE are set, else a locally minted token on a
 * test deployment. The local branch reads a view without ENTRA_TENANT_ID/AUTH_AUDIENCE: on the
 * stack the tenant id is shared but this app has no audience, and authFromEnv would refuse it.
 */
export function newsApiTokenOptions(
  parsed: Pick<z.infer<ReturnType<typeof publicSiteEnvSchema>>, "NEWS_API_TOKEN_URL" | "NEWS_API_CLIENT_ID" | "NEWS_API_CLIENT_SECRET" | "NEWS_API_SCOPE">,
  env: NodeJS.ProcessEnv,
): ServiceTokenOptions {
  const local: LocalAuthConfig | null =
    env.LOCAL_ADMIN_ENABLED === "true" ? authFromEnv({ ...env, ENTRA_TENANT_ID: undefined, AUTH_AUDIENCE: undefined, SESSION_SECRET: undefined }).local : null;
  return {
    tokenUrl: parsed.NEWS_API_TOKEN_URL,
    clientId: parsed.NEWS_API_CLIENT_ID,
    clientSecret: parsed.NEWS_API_CLIENT_SECRET,
    scope: parsed.NEWS_API_SCOPE,
    local,
    subject: "site-builder",
    roles: [NEWS_API_CHANGES_ROLE],
    envPrefix: "NEWS_API",
  };
}
