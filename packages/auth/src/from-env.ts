import type { Router } from "express";
import { z } from "zod";
import { entraIssuer, entraJwks, type BearerOptions } from "./bearer";
import { localLoginRouter, type LocalAuthConfig } from "./local";
import { isValidPasswordHash } from "./password";

const boolString = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

const schema = z
  .object({
    NODE_ENV: z.string().optional(),
    ENTRA_TENANT_ID: z.string().min(1).optional(),
    AUTH_AUDIENCE: z.string().min(1).optional(),
    LOCAL_ADMIN_ENABLED: boolString,
    LOCAL_ADMIN_ALLOW_IN_PRODUCTION: boolString,
    LOCAL_ADMIN_USERNAME: z.string().min(1).default("admin"),
    LOCAL_ADMIN_PASSWORD_HASH: z.string().optional(),
    LOCAL_AUTH_SECRET: z.string().optional(),
    SESSION_SECRET: z.string().optional(),
    /** The stack's own app-to-app token key (internal.ts), derived by envFor from
     * STACK_EVENT_SECRET. Independent of LOCAL_ADMIN_*, so break-glass can be off in production. */
    SERVICE_TOKEN_SECRET: z.string().optional(),
    /** Set by the stack for every app: refuse a cookie (503) while Core's session check isn't installed. */
    SESSION_GATE_REQUIRED: boolString,
    SESSION_COOKIE_SECURE: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
    /** Owner decision 2026-10-31: how long a staff session lasts from sign-in, whatever the renewals. */
    SESSION_MAX_HOURS: z.coerce
      .number({ invalid_type_error: "SESSION_MAX_HOURS must be a number of hours" })
      .positive("SESSION_MAX_HOURS must be more than 0")
      .max(168, "SESSION_MAX_HOURS must be at most 168 (a week)")
      .default(12),
  })
  .superRefine((e, ctx) => {
    if (e.SESSION_SECRET !== undefined && e.SESSION_SECRET.length < 32)
      ctx.addIssue({ code: "custom", message: "SESSION_SECRET must be at least 32 characters" });
    if (e.SERVICE_TOKEN_SECRET !== undefined && e.SERVICE_TOKEN_SECRET.length < 32)
      ctx.addIssue({ code: "custom", message: "SERVICE_TOKEN_SECRET must be at least 32 characters" });
    if (Boolean(e.ENTRA_TENANT_ID) !== Boolean(e.AUTH_AUDIENCE))
      ctx.addIssue({ code: "custom", message: "set both ENTRA_TENANT_ID and AUTH_AUDIENCE, or neither" });
    if (e.LOCAL_ADMIN_ENABLED) {
      if (!e.LOCAL_ADMIN_PASSWORD_HASH || !isValidPasswordHash(e.LOCAL_ADMIN_PASSWORD_HASH))
        ctx.addIssue({ code: "custom", message: "LOCAL_ADMIN_PASSWORD_HASH must be the output of `npm run auth:hash-password`" });
      if (!e.LOCAL_AUTH_SECRET || e.LOCAL_AUTH_SECRET.length < 32)
        ctx.addIssue({ code: "custom", message: "LOCAL_AUTH_SECRET must be at least 32 characters" });
      if (e.NODE_ENV === "production" && !e.LOCAL_ADMIN_ALLOW_IN_PRODUCTION)
        ctx.addIssue({
          code: "custom",
          message: "LOCAL_ADMIN_ENABLED is refused when NODE_ENV=production unless LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true — Entra remains the only production identity provider",
        });
    }
    if (!e.ENTRA_TENANT_ID && !e.LOCAL_ADMIN_ENABLED)
      ctx.addIssue({ code: "custom", message: "configure ENTRA_TENANT_ID + AUTH_AUDIENCE, or LOCAL_ADMIN_ENABLED=true (test environments)" });
  });

export function authFromEnv(
  env: NodeJS.ProcessEnv,
): {
  bearer: BearerOptions;
  loginRouter: Router | null;
  local: LocalAuthConfig | null;
  /** The stack's internal service-token key, for this app's own calls to the others (serviceTokenProvider). */
  internal: { secret: string } | null;
  session: { secret: string; secure: boolean; maxSessionSeconds: number } | null;
} {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`auth configuration: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const e = parsed.data;
  const local = e.LOCAL_ADMIN_ENABLED ? { username: e.LOCAL_ADMIN_USERNAME, passwordHash: e.LOCAL_ADMIN_PASSWORD_HASH!, secret: e.LOCAL_AUTH_SECRET! } : null;
  if (local) console.warn("[auth] LOCAL ADMIN LOGIN ENABLED — test environments only");
  const internal = e.SERVICE_TOKEN_SECRET ? { secret: e.SERVICE_TOKEN_SECRET } : null;
  const maxSessionSeconds = Math.round(e.SESSION_MAX_HOURS * 3600);
  const session = e.SESSION_SECRET ? { secret: e.SESSION_SECRET, secure: e.SESSION_COOKIE_SECURE, maxSessionSeconds } : null;
  return {
    bearer: {
      ...(e.ENTRA_TENANT_ID ? { issuer: entraIssuer(e.ENTRA_TENANT_ID), audience: e.AUTH_AUDIENCE!, keys: entraJwks(e.ENTRA_TENANT_ID) } : {}),
      // Review S M8: break-glass tokens are checked against the current password and session limit.
      ...(local ? { local: { secret: local.secret, breakGlass: { username: local.username, passwordHash: local.passwordHash, maxSessionSeconds, gateRequired: e.SESSION_GATE_REQUIRED } } } : {}),
      ...(internal ? { internal } : {}),
      ...(session ? { session: { ...session, gateRequired: e.SESSION_GATE_REQUIRED } } : {}),
    },
    loginRouter: local ? localLoginRouter(local, { maxSessionSeconds }) : null,
    local,
    internal,
    session,
  };
}
