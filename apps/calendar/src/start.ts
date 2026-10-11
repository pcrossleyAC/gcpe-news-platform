import { fileURLToPath } from "node:url";
import { z } from "zod";
import type express from "express";
import { authFromEnv } from "@gcpe/auth";
import { assertTimeZoneRules, eventSecretsSchema, loadTenantConfig, parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { dispatchOnce, parseSubscribers, startDispatcher } from "@gcpe/events";
import { type Closer, safeErrorLabel } from "@gcpe/http-kit";
import { localStore } from "@gcpe/storage";
import { sweepLocks } from "./activities/locks";
import { createApp } from "./app";
import type { ApiDeps } from "./http/routes";
import { needsReferenceData } from "./projections";
import { ReportJobs } from "./reports/jobs";
import { reportAssets } from "./reports/render/assets";
import { workerRenderer } from "./reports/render/renderer";
import { rulesFromTenant } from "./rules";

export const calendarEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().default(3007),
  EVENT_SUBSCRIBERS: z.string().optional(),
  EVENT_SECRETS: eventSecretsSchema,
  MIGRATIONS_FOLDER: z.string().default(fileURLToPath(new URL("../migrations", import.meta.url))),
  TENANT_CONFIG: z.string().default(fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url))),
  // Attachments (spec addendum §5.1): outside the deploy folder and never under a public path. In the
  // stack this is CALENDAR_STORAGE_DIR, defaulting to <DATA_DIR>/calendar-files.
  STORAGE_DIR: z.string().min(1).default(fileURLToPath(new URL("../../../data/calendar-files", import.meta.url))),
  // Reports (spec addendum §10): each PDF is drawn in a worker thread with its own heap, one at a time
  // by default. A start waits this long for its PDF before answering 202 and letting the browser poll,
  // so no request outlives a proxy's timeout, whatever it is.
  REPORT_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  REPORT_HEAP_MB: z.coerce.number().int().min(64).max(4096).default(320),
  REPORT_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(900).default(120),
  REPORT_INLINE_WAIT_MS: z.coerce.number().int().min(0).max(25_000).default(5000),
});

/** The report jobs, or null when the worker or BC Sans can't be found: the Calendar runs, its reports answer 503. */
function startReports(p: z.infer<typeof calendarEnvSchema>): ApiDeps["reports"] {
  try {
    const renderer = workerRenderer({ ...reportAssets(), heapMb: p.REPORT_HEAP_MB, timeoutMs: p.REPORT_TIMEOUT_SECONDS * 1000 });
    return { jobs: new ReportJobs({ renderer, concurrency: p.REPORT_CONCURRENCY }), inlineWaitMs: p.REPORT_INLINE_WAIT_MS };
  } catch (e) {
    console.error("[calendar] reports are unavailable: the report worker or its fonts weren't found", safeErrorLabel(e));
    return null;
  }
}

export interface AppHandle {
  app: express.Express;
  port: number;
  workers: Record<string, () => Promise<unknown>>;
  startLoops(): void;
  closeBeforeServer: Closer[];
  closers: Closer[];
  storageDir: string;
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
  const store = localStore(parsed.STORAGE_DIR);
  // No local login router: the token it issues is a bearer token, which has no Calendar access.
  const reports = startReports(parsed);
  const app = createApp({ db, auth: auth.bearer, eventSecrets: parsed.EVENT_SECRETS, rules, subscribers, store, reports });

  let stopDispatcher: (() => Promise<void>) | undefined;
  let sweep: NodeJS.Timeout | undefined;
  return {
    app,
    port: parsed.PORT,
    storageDir: parsed.STORAGE_DIR,
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
      { name: "report jobs", close: async () => { await reports?.jobs.close(); } },
      { name: "db pool", close: () => pool.end() },
    ],
  };
}
