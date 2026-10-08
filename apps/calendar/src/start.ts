import { fileURLToPath } from "node:url";
import { z } from "zod";
import type express from "express";
import { authFromEnv } from "@gcpe/auth";
import { assertTimeZoneRules, eventSecretsSchema, loadTenantConfig, parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { dispatchOnce, parseSubscribers, startDispatcher } from "@gcpe/events";
import { type Closer, safeErrorLabel } from "@gcpe/http-kit";
import { sweepLocks } from "./activities/locks";
import { createApp } from "./app";
import { needsReferenceData } from "./projections";
import { rulesFromTenant } from "./rules";

export const calendarEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().default(3007),
  EVENT_SUBSCRIBERS: z.string().optional(),
  EVENT_SECRETS: eventSecretsSchema,
  MIGRATIONS_FOLDER: z.string().default(fileURLToPath(new URL("../migrations", import.meta.url))),
  TENANT_CONFIG: z.string().default(fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url))),
});

export interface AppHandle {
  app: express.Express;
  port: number;
  workers: Record<string, () => Promise<unknown>>;
  startLoops(): void;
  closeBeforeServer: Closer[];
  closers: Closer[];
}

/** Parses env, checks the tenant's tzdata, runs migrations, and builds the app and its dispatcher. */
export async function startCalendar(env: NodeJS.ProcessEnv): Promise<AppHandle> {
  const parsed = parseEnv(calendarEnvSchema, env);
  // Freeze windows and every BC time shown depend on tzdata ≥ 2026b (permanent UTC−7 from 2026-11-01).
  const tenant = loadTenantConfig(parsed.TENANT_CONFIG);
  assertTimeZoneRules(tenant);
  const rules = rulesFromTenant(tenant);
  const auth = authFromEnv(env);
  const { db, pool } = createDb(parsed.DATABASE_URL);
  await runMigrations(db, parsed.MIGRATIONS_FOLDER);
  const subscribers = parseSubscribers(parsed.EVENT_SUBSCRIBERS);
  // No local login router: the token it issues is a bearer token, which has no Calendar access.
  const app = createApp({ db, auth: auth.bearer, eventSecrets: parsed.EVENT_SECRETS, rules, subscribers });

  let stopDispatcher: (() => Promise<void>) | undefined;
  let sweep: NodeJS.Timeout | undefined;
  return {
    app,
    port: parsed.PORT,
    workers: {
      // Delivers activity.* to NRMS.
      dispatch: () => dispatchOnce({ db, subscribers }),
      needsReferenceData: () => needsReferenceData(db),
      lockSweep: () => sweepLocks(db),
    },
    startLoops() {
      stopDispatcher = startDispatcher({ db, subscribers });
      sweep = setInterval(() => void sweepLocks(db).catch((e) => console.error("[calendar] lock sweep failed", safeErrorLabel(e))), 60_000);
      sweep.unref();
    },
    closeBeforeServer: [],
    closers: [
      { name: "event dispatcher", close: async () => { await stopDispatcher?.(); } },
      { name: "lock sweep", close: async () => clearInterval(sweep) },
      { name: "db pool", close: () => pool.end() },
    ],
  };
}
