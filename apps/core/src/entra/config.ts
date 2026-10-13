/**
 * Core's staff sign-in settings, read from Core's own env view: in the
 * stack these are CORE_ENTRA_CLIENT_ID, CORE_ENTRA_CLIENT_SECRET, CORE_PUBLIC_BASE_URL and
 * CORE_LOCAL_PASSWORDS_ALLOWED, plus the shared ENTRA_TENANT_ID and SESSION_SECRET.
 */
export interface EntraSignInConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Issuer and discovery base: Microsoft's v2.0 endpoint for the tenant, unless a test site points it at the fake. */
  authority: string;
  /** `<PUBLIC_BASE_URL>/core/auth/entra/callback`: the redirect URI registered in Entra. */
  redirectUri: string;
}

export interface SignInSettings {
  entra: EntraSignInConfig | null;
  /** False only in real production (C39: not a test site) with Entra on and
   * LOCAL_PASSWORDS_ALLOWED not "true". The break-glass admin is unaffected. */
  userPasswordsAllowed: boolean;
}

export const ENTRA_CALLBACK_PATH = "/core/auth/entra/callback";

const TRIGGERS = ["ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET", "PUBLIC_BASE_URL"] as const;
const REQUIRED = ["ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET", "PUBLIC_BASE_URL", "SESSION_SECRET"] as const;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const set = (env: NodeJS.ProcessEnv, key: string) => typeof env[key] === "string" && env[key] !== "";

function publicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be an absolute URL, e.g. https://news.example.test");
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || url.username || url.password) {
    throw new Error("PUBLIC_BASE_URL must be an origin only (scheme and host), with no path");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new Error("PUBLIC_BASE_URL must use https (http only for localhost)");
  }
  return url.origin;
}

/**
 * Parses and checks the sign-in settings. Entra sign-in is on when ENTRA_CLIENT_ID,
 * ENTRA_CLIENT_SECRET or PUBLIC_BASE_URL is set; then every one of them, ENTRA_TENANT_ID and
 * SESSION_SECRET must be set too, or this throws naming what's missing. ENTRA_TENANT_ID alone
 * (service-to-service tokens) leaves sign-in off. Throws on any invalid value, so startCore and
 * `stack --check` fail the same way.
 */
export function signInSettingsFromEnv(env: NodeJS.ProcessEnv): SignInSettings {
  const allowed = env.LOCAL_PASSWORDS_ALLOWED;
  if (allowed !== undefined && allowed !== "true" && allowed !== "false") throw new Error('LOCAL_PASSWORDS_ALLOWED must be "true" or "false"');
  // C39's test-site rule, shared with the fake's own production guard (apps/stack/src/env.ts,
  // usesFakeEntra): NODE_ENV isn't "production", or it is but the deployment is marked a test
  // site anyway (LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true, or SITE_ENVIRONMENT=test, e.g. boxs.ca).
  // Computed once and reused below for both guards this function makes, so the two can't drift.
  const testDeployment = env.NODE_ENV !== "production" || env.LOCAL_ADMIN_ALLOW_IN_PRODUCTION === "true" || env.SITE_ENVIRONMENT === "test";

  if (!TRIGGERS.some((k) => set(env, k))) {
    if (set(env, "ENTRA_AUTHORITY_URL")) throw new Error("ENTRA_AUTHORITY_URL is set but Entra sign-in is not: set ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET and PUBLIC_BASE_URL too");
    return { entra: null, userPasswordsAllowed: true };
  }
  const missing = REQUIRED.filter((k) => !set(env, k));
  if (missing.length > 0) throw new Error(`Entra sign-in is partly configured: missing ${missing.join(", ")}`);

  const tenantId = env.ENTRA_TENANT_ID!;
  let authority = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/v2.0`;
  if (set(env, "ENTRA_AUTHORITY_URL")) {
    if (!testDeployment) throw new Error("ENTRA_AUTHORITY_URL is for test sites only and is refused in production");
    authority = env.ENTRA_AUTHORITY_URL!.replace(/\/+$/, "");
  }
  return {
    entra: {
      tenantId,
      clientId: env.ENTRA_CLIENT_ID!,
      clientSecret: env.ENTRA_CLIENT_SECRET!,
      authority,
      redirectUri: `${publicOrigin(env.PUBLIC_BASE_URL!)}${ENTRA_CALLBACK_PATH}`,
    },
    userPasswordsAllowed: testDeployment || allowed === "true",
  };
}
