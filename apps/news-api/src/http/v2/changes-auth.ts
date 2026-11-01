import { authFromEnv, type BearerOptions } from "@gcpe/auth";

/**
 * Bearer options for `GET /api/v2/changes` (and `/internal/similar`), or null when this News API has no way to verify a
 * token (the route then answers 503). Entra counts only when both ENTRA_TENANT_ID and
 * AUTH_AUDIENCE are set: on the stack ENTRA_TENANT_ID is shared by every app, but the News API
 * has no audience of its own unless NEWSAPI_AUTH_AUDIENCE is set. The session secret is never
 * passed: a staff cookie must not open a service feed.
 */
export function changesBearerFromEnv(env: NodeJS.ProcessEnv): BearerOptions | null {
  const entra = Boolean(env.ENTRA_TENANT_ID && env.AUTH_AUDIENCE);
  const local = env.LOCAL_ADMIN_ENABLED === "true";
  // The stack's own internal token (2026-10-31, T2): the site builder and NRMS call in-process,
  // so this is what they use in every stack deployment, with break-glass on or off.
  const internal = env.SERVICE_TOKEN_SECRET ? { secret: env.SERVICE_TOKEN_SECRET } : undefined;
  if (!entra && !local) return internal ? { internal } : null;
  const view: NodeJS.ProcessEnv = { ...env, SESSION_SECRET: undefined };
  if (!entra) {
    view.ENTRA_TENANT_ID = undefined;
    view.AUTH_AUDIENCE = undefined;
  }
  const { bearer } = authFromEnv(view);
  return { issuer: bearer.issuer, audience: bearer.audience, keys: bearer.keys, local: bearer.local, internal: bearer.internal };
}
