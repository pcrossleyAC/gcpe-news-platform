import type { Router } from "express";
import { z } from "zod";
import { entraIssuer, entraJwks, type BearerOptions } from "./bearer";
import { localLoginRouter, type LocalAuthConfig } from "./local";
import { PASSWORD_HASH_FORMAT } from "./password";

const schema = z
  .object({
    ENTRA_TENANT_ID: z.string().min(1).optional(),
    AUTH_AUDIENCE: z.string().min(1).optional(),
    LOCAL_ADMIN_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    LOCAL_ADMIN_USERNAME: z.string().min(1).default("admin"),
    LOCAL_ADMIN_PASSWORD_HASH: z.string().optional(),
    LOCAL_AUTH_SECRET: z.string().optional(),
  })
  .superRefine((e, ctx) => {
    if (Boolean(e.ENTRA_TENANT_ID) !== Boolean(e.AUTH_AUDIENCE))
      ctx.addIssue({ code: "custom", message: "set both ENTRA_TENANT_ID and AUTH_AUDIENCE, or neither" });
    if (e.LOCAL_ADMIN_ENABLED) {
      if (!e.LOCAL_ADMIN_PASSWORD_HASH || !PASSWORD_HASH_FORMAT.test(e.LOCAL_ADMIN_PASSWORD_HASH))
        ctx.addIssue({ code: "custom", message: "LOCAL_ADMIN_PASSWORD_HASH must be the output of `npm run auth:hash-password`" });
      if (!e.LOCAL_AUTH_SECRET || e.LOCAL_AUTH_SECRET.length < 32)
        ctx.addIssue({ code: "custom", message: "LOCAL_AUTH_SECRET must be at least 32 characters" });
    }
    if (!e.ENTRA_TENANT_ID && !e.LOCAL_ADMIN_ENABLED)
      ctx.addIssue({ code: "custom", message: "configure ENTRA_TENANT_ID + AUTH_AUDIENCE, or LOCAL_ADMIN_ENABLED=true (test environments)" });
  });

export function authFromEnv(env: NodeJS.ProcessEnv): { bearer: BearerOptions; loginRouter: Router | null; local: LocalAuthConfig | null } {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`auth configuration: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const e = parsed.data;
  const local = e.LOCAL_ADMIN_ENABLED ? { username: e.LOCAL_ADMIN_USERNAME, passwordHash: e.LOCAL_ADMIN_PASSWORD_HASH!, secret: e.LOCAL_AUTH_SECRET! } : null;
  if (local) console.warn("[auth] LOCAL ADMIN LOGIN ENABLED — test environments only");
  return {
    bearer: {
      ...(e.ENTRA_TENANT_ID ? { issuer: entraIssuer(e.ENTRA_TENANT_ID), audience: e.AUTH_AUDIENCE!, keys: entraJwks(e.ENTRA_TENANT_ID) } : {}),
      ...(local ? { local: { secret: local.secret } } : {}),
    },
    loginRouter: local ? localLoginRouter(local) : null,
    local,
  };
}
