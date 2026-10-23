import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { hashPassword, mintSession, SESSION_COOKIE } from "@gcpe/auth";
import { createDb } from "@gcpe/db-kit";
import { findUserByEmail, sessionUserFor } from "../../../apps/core/src/services/users";
import { startSmtpSink } from "../../../apps/distribution/test/smtp-sink";
import { sessionSecretFrom } from "../../../apps/stack/src/env";
import { startStack } from "../../../apps/stack/src/stack";
import { bcToday } from "./dates";
import { PLACEHOLDER_SUBSCRIBER, runStep, type CommandStep, type LocalApp } from "./local";
import { ScrubStepError } from "./private-out";
import { runSmoke, type SmokeCheck } from "./smoke";

/**
 * Ticks until deliveries drain, judged by progress rather than a fixed tick count: a legacy-scale
 * replay (tens of thousands of activities/release statuses) can take far more than a few hundred
 * ticks to drain, so what matters is whether the pending count keeps falling, not how many ticks
 * that takes. Fails only when the lowest pending count seen hasn't improved for `staleTicks`
 * consecutive ticks (default 50 — tolerates a tick or two of no progress without tolerating a
 * real stall), or when `maxWallMs` (default two hours) has passed. The dead-delivery check and
 * the two-quiet-ticks completion are unchanged. `log`, if given, gets one line every 100 ticks —
 * the tick number and the pending count, nothing else.
 */
export async function drainUntilIdle(o: {
  tick(): Promise<void>;
  pending(): Promise<{ pending: number; dead: number }>;
  staleTicks?: number;
  maxWallMs?: number;
  log?(line: string): void;
}): Promise<number> {
  const staleTicks = o.staleTicks ?? 50;
  const deadline = Date.now() + (o.maxWallMs ?? 2 * 60 * 60 * 1000);
  let quiet = 0;
  let lowest = Infinity;
  let stale = 0;
  for (let i = 1; ; i++) {
    await o.tick();
    const s = await o.pending();
    if (s.dead > 0) throw new ScrubStepError(`${s.dead} event deliveries failed for good`);
    if (o.log && i % 100 === 0) o.log(`tick ${i}: ${s.pending} pending`);
    quiet = s.pending === 0 ? quiet + 1 : 0;
    if (quiet >= 2) return i;
    if (s.pending < lowest) {
      lowest = s.pending;
      stale = 0;
    } else {
      stale++;
      if (stale >= staleTicks) throw new ScrubStepError(`event delivery stalled with ${s.pending} still pending`);
    }
    if (Date.now() > deadline) throw new ScrubStepError(`event delivery timed out with ${s.pending} still pending`);
  }
}

export function replaySteps(urls: Record<LocalApp, string>): CommandStep[] {
  return [
    { name: "calendar-replay-to-nrms", npmArgs: ["run", "calendar:replay-to-nrms", "--", "--confirm"], env: { DATABASE_URL: urls.calendar, EVENT_SUBSCRIBERS: JSON.stringify([PLACEHOLDER_SUBSCRIBER("nrms", ["activity.updated"])]) } },
    { name: "nrms-replay-activity-links", npmArgs: ["run", "nrms:replay-activity-links", "--", "--confirm"], env: { DATABASE_URL: urls.nrms, EVENT_SUBSCRIBERS: JSON.stringify([PLACEHOLDER_SUBSCRIBER("calendar", ["release.status_changed"])]) } },
    { name: "news-api-search-backfill", npmArgs: ["run", "news-api:search-backfill", "--", "--confirm"], env: { DATABASE_URL: urls.newsApi } },
  ];
}

async function pendingDeliveries(urls: string[]): Promise<{ pending: number; dead: number }> {
  let pending = 0, dead = 0;
  for (const url of urls) {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      if ((await c.query<{ t: string | null }>("SELECT to_regclass('public.outbox_deliveries')::text AS t")).rows[0]!.t === null) continue;
      const r = (await c.query<{ p: number; d: number }>("SELECT count(*) FILTER (WHERE status = 'pending')::int AS p, count(*) FILTER (WHERE status = 'dead')::int AS d FROM outbox_deliveries")).rows[0]!;
      pending += r.p; dead += r.d;
    } finally {
      await c.end();
    }
  }
  return { pending, dead };
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address() as AddressInfo; s.close(() => res(port)); });
  });
}

export interface TrialResult { ticks: number; smoke: SmokeCheck[] }

/** The whole stack, in process, on the scrubbed local databases: events delivered, replays run, then the smoke test. */
export async function runTrial(o: { urls: Record<LocalApp, string>; out: string; calendarUser: string; releaseUser: string; log(line: string): void }): Promise<TrialResult> {
  const dataDir = join(o.out, "trial-data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const secret = () => randomBytes(32).toString("hex");
  const adminPassword = secret(), stackSecret = secret(), tickToken = secret();
  const sink = await startSmtpSink();
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    PORT: String(port), TICK_TOKEN: tickToken, STACK_LOOPS: "false", UPDATES_HUB_ENABLED: "false", NODE_ENV: "test", DATA_DIR: dataDir,
    LOCAL_ADMIN_ENABLED: "true", LOCAL_ADMIN_USERNAME: "admin", LOCAL_ADMIN_PASSWORD_HASH: await hashPassword(adminPassword), LOCAL_AUTH_SECRET: secret(), STACK_EVENT_SECRET: stackSecret,
    CORE_DATABASE_URL: o.urls.core, NRMS_DATABASE_URL: o.urls.nrms, NEWSAPI_DATABASE_URL: o.urls.newsApi, CALENDAR_DATABASE_URL: o.urls.calendar,
    SITE_DATABASE_URL: o.urls.site, SITE_NEWS_API_URL: "self:/", SITE_OUTPUT_DIR: join(dataDir, "site-output"), SITE_PUBLIC_SITE_URL: "self:/site",
    NOD_DATABASE_URL: o.urls.nod, NOD_DISTRIBUTION_URL: "self:/distribution", NOD_PUBLIC_SITE_URL: "self:/site", NOD_MEMBERSHIP_API_USERNAME: "trial", NOD_MEMBERSHIP_API_PASSWORD_HASH: await hashPassword(secret()),
    DIST_DATABASE_URL: o.urls.distribution, DIST_SMTP_HOST: "127.0.0.1", DIST_SMTP_PORT: String(sink.port), DIST_SMTP_SECURE: "false", DIST_MAIL_FROM: "noreply@example.test", DIST_MAIL_REDIRECT_TO: "trial@example.test",
  };
  const handle = await startStack(env);
  const server = createServer(handle.app);
  await new Promise<void>((res) => server.listen(handle.port, "127.0.0.1", () => res()));
  const base = `http://127.0.0.1:${handle.port}`;
  const quietly = async (fn: () => unknown) => { try { await fn(); } catch { /* shutting down: the next close still runs */ } };
  try {
    const tick = async () => { const r = await fetch(`${base}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${tickToken}` } }); if (!r.ok) throw new ScrubStepError(`a tick answered HTTP ${r.status}`); };
    const pending = () => pendingDeliveries(Object.values(o.urls));
    const tokenRes = await fetch(`${base}/core/auth/local/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: adminPassword }) });
    const token = ((await tokenRes.json()) as { access_token?: string }).access_token;
    if (!token) throw new ScrubStepError("the trial stack refused its own admin sign-in");
    const rep = await fetch(`${base}/core/api/admin/republish`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    if (rep.status !== 202) throw new ScrubStepError(`Core's republish answered HTTP ${rep.status}`);
    let ticks = await drainUntilIdle({ tick, pending, log: o.log });
    o.log(`Delivered Core's republish in ${ticks} ticks.`);
    for (const s of replaySteps(o.urls)) {
      const code = await runStep(s, join(o.out, "logs", `${s.name}.log`));
      if (code !== 0) throw new ScrubStepError(`${s.name} exited ${code}: see logs/${s.name}.log`);
    }
    ticks += await drainUntilIdle({ tick, pending, log: o.log });
    const { db, pool } = createDb(o.urls.core);
    let calendarCookie: string, releaseCookie: string;
    try {
      const cookieFor = async (email: string) => {
        const found = await findUserByEmail(db, email);
        const user = found && (await sessionUserFor(db, found.id));
        if (!user) throw new ScrubStepError(`test account ${email} is missing or inactive`);
        return `${SESSION_COOKIE}=${(await mintSession(sessionSecretFrom(stackSecret), user)).token}`;
      };
      calendarCookie = await cookieFor(o.calendarUser);
      releaseCookie = await cookieFor(o.releaseUser);
    } finally {
      await pool.end();
    }
    return { ticks, smoke: await runSmoke({ base, calendarCookie, releaseCookie, today: bcToday() }) };
  } finally {
    for (const c of handle.closeBeforeServer) await quietly(() => c.close());
    await new Promise<void>((res) => { server.closeAllConnections(); server.close(() => res()); });
    for (const c of handle.closers) await quietly(() => c.close());
    await quietly(() => sink.close());
  }
}
