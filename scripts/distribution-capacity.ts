#!/usr/bin/env -S node --
// Measures how fast Distribution's sender can drain a queue locally, and confirms the
// database-enforced per-minute cap (sender.ts's send_rate_windows) holds when two workers claim
// against it at once. A dev tool only — queues synthetic @example.test recipients into a
// throwaway Postgres database (the same createTestDatabase helper Distribution's own tests use)
// and sends them to a local SMTP sink, never a real mailbox.
//
// Usage:
//   npm run distribution:capacity                              # N=20000, in-process SMTP sink
//   npm run distribution:capacity -- --n 2000                  # a smaller run
//   npm run distribution:capacity -- --smtp 127.0.0.1:1025      # against a running Mailpit
//   npm run distribution:capacity -- --skip-phase-b             # throughput only
//
// Safety: refuses to run against any SMTP target (the --smtp argument) or database admin
// target (TEST_DATABASE_ADMIN_URL, or db-kit's own localhost default) that isn't
// localhost/127.0.0.1/::1 (or a unix-socket path), never addresses anyone but <local
// part>@example.test, and never reads a .env file (nothing here imports dotenv; only the
// process's own already-set env vars, e.g. TEST_DATABASE_ADMIN_URL, are read).
import { pathToFileURL } from "node:url";
import nodemailer, { type Transporter } from "nodemailer";
import { sql } from "drizzle-orm";
import type { ParsedMail } from "mailparser";
import { createDistributionTestDb } from "../apps/distribution/test/helpers";
import { startSmtpSink } from "../apps/distribution/test/smtp-sink";
import { createBatch, type MessageRequest } from "../apps/distribution/src/messages";
import { sendDue } from "../apps/distribution/src/sender";
import { sendRateWindows } from "../apps/distribution/src/db/schema";
import type { Db, TestDatabase } from "@gcpe/db-kit";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** True for localhost/127.0.0.1/::1 (brackets stripped, so `new URL(...)`'s own `[::1]`
 * spelling for IPv6 hostnames still matches), or a unix-socket directory path (which can only
 * ever name something on this machine). */
function isLocalHost(host: string): boolean {
  const normalized = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (LOCAL_HOSTS.has(normalized)) return true;
  return normalized.startsWith("/");
}

/** Refuses anything but a local SMTP target — one of this script's two real safety rails
 * (the other is {@link assertLocalDatabaseAdminTarget}), since it's what stands between
 * "throwaway sink" and "a batch of made-up addresses hitting a real relay". */
function assertLocalHost(host: string, source: string): void {
  if (!isLocalHost(host)) {
    throw new Error(`distribution-capacity: refusing non-local SMTP target "${host}" (from ${source}) — this script only ever runs against localhost`);
  }
}

function parseSmtpTarget(value: string): { host: string; port: number } {
  const [host, portStr] = value.split(":");
  const port = Number(portStr);
  if (!host || !Number.isInteger(port) || port <= 0) {
    throw new Error(`distribution-capacity: --smtp must be "host:port" (got "${value}")`);
  }
  assertLocalHost(host, "--smtp");
  return { host, port };
}

/** Mirrors packages/db-kit/src/test-db.ts's own `adminUrl()` default exactly — that function
 * isn't importable here (the package's "exports" field exposes only its index, which doesn't
 * re-export it), so the same default is replicated for this pre-flight check. */
function effectiveDatabaseAdminUrl(): string {
  return process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://localhost:5432/postgres";
}

/** `createDistributionTestDb()` creates, migrates and drops its throwaway database against
 * whatever `TEST_DATABASE_ADMIN_URL` names (or db-kit's own localhost default) — the
 * SMTP-target guard above says nothing about that. Refuses anything but a local target, the
 * same way, before any `CREATE DATABASE` happens. */
function assertLocalDatabaseAdminTarget(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`distribution-capacity: could not parse the database admin URL "${rawUrl}"`);
  }
  // pg-connection-string (what `pg` itself uses to parse this URL) takes a "?host=" query
  // param over the URL's own hostname whenever one is present — not only when the hostname is
  // empty — so this has to check it first, the same way, or "postgres://localhost/db?host=
  // evil.example" would read as local here while `pg` actually connects to evil.example. When
  // neither a host param nor a hostname is set, `pg` falls back to PGHOST (then "localhost"),
  // the same precedence its own connection-parameters.js applies — hard-coding "localhost" for
  // an empty host would let a remote PGHOST connect past this guard unseen.
  const hostParam = parsed.searchParams.get("host");
  const candidate = hostParam || parsed.hostname || process.env.PGHOST || "localhost";
  if (!isLocalHost(candidate)) {
    throw new Error(
      `distribution-capacity: refusing a non-local database admin target "${candidate}" (TEST_DATABASE_ADMIN_URL, or db-kit's own default) — this script only ever creates/migrates/drops its throwaway database on localhost`,
    );
  }
}

function baseMessageRequest(subjectTag: string): Omit<MessageRequest, "recipients"> {
  return {
    priority: "immediate",
    subject: `Capacity measurement (${subjectTag})`,
    html: "<p>Capacity measurement.</p>",
    text: "Capacity measurement.",
    headers: {},
    attachments: [],
  };
}

// createBatch's own schema caps a single request at 20,000 recipients — chunk larger runs into
// several batches rather than failing outright.
const MAX_RECIPIENTS_PER_BATCH = 20_000;

/** Queues `count` fresh synthetic recipients (never reused across calls — each gets a globally
 * unique local part) across as many batches as `createBatch`'s 20,000-recipient cap requires.
 * Returns every address queued, so a caller can cross-check what actually arrived at the sink
 * against exactly this list (addresses and count), not just a count. */
async function queueRecipients(db: Db, count: number, tag: string): Promise<string[]> {
  const queued: string[] = [];
  for (let start = 0; start < count; start += MAX_RECIPIENTS_PER_BATCH) {
    const chunk = Math.min(MAX_RECIPIENTS_PER_BATCH, count - start);
    const recipients = Array.from({ length: chunk }, (_, i) => ({ email: `cap-${tag}-${start + i}@example.test`, substitutions: {} }));
    await createBatch(db, "distribution-capacity", { ...baseMessageRequest(tag), recipients }, []);
    queued.push(...recipients.map((r) => r.email));
  }
  return queued;
}

async function countPending(db: Db): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM messages WHERE status = 'pending'`);
  return rows[0]?.n ?? 0;
}

/** The single recipient address mailparser recorded for a sink message — same extraction
 * `sender.test.ts` uses to look up a delivered message by its "to". */
function addressOf(m: ParsedMail): string | undefined {
  return m.to && "value" in m.to ? m.to.value[0]?.address : undefined;
}

export interface PhaseARow {
  concurrency: number;
  elapsedMs: number;
  sendsPerMinute: number;
  delivered: number;
  /** How many messages the in-process sink actually recorded for this concurrency's run, cross-
   * checked against `delivered` and `n` (see runPhaseA). `null` when running against an
   * external `--smtp` target, which has no equivalent in-process message list to check. */
  sinkReceived: number | null;
  /** Count of recipient addresses the sink saw more than once in this run. Always 0 when
   * `sinkReceived` isn't null and nothing is wrong; `0` (not null) when there's no sink, since
   * "no sink to check" and "checked, no duplicates" are different states only `sinkReceived`
   * needs to distinguish. */
  duplicateRecipients: number;
}

export interface PhaseBWindow {
  windowStart: string;
  claimed: number;
}

export interface PhaseBResult {
  capPerMinute: number;
  workers: number;
  durationMs: number;
  windows: PhaseBWindow[];
  /** True only if every recorded window's claimed count stayed at or under capPerMinute. */
  held: boolean;
}

export interface CapacityResult {
  n: number;
  machine: string;
  nodeVersion: string;
  postgresVersion: string;
  sink: string;
  phaseA: PhaseARow[];
  phaseB?: PhaseBResult;
  markdown: string;
}

export interface CapacityOptions {
  /** Recipients queued per Phase A concurrency run. Default 20,000 (the real measurement). */
  n?: number;
  /** Concurrencies to measure in Phase A, in order. Default [1, 2, 4, 8]. */
  concurrencies?: number[];
  /** "host:port" of a running local SMTP server (e.g. Mailpit). Omit to use the in-process
   * smtp-server sink (the default — see the self-review notes on why that's measured instead
   * of Mailpit). */
  smtp?: string;
  /** Run Phase B (cap-holds). Default true. */
  phaseB?: boolean;
  capPerMinute?: number;
  phaseBDurationMs?: number;
  phaseBWorkers?: number;
  /** Batch size each sendDue call claims up to. Default 500 — large enough that the claim
   * itself, not the per-call round trip, is the throughput bottleneck. */
  batchSize?: number;
}

const DEFAULT_N = 20_000;
const DEFAULT_CONCURRENCIES = [1, 2, 4, 8];
const DEFAULT_PHASE_B_CAP = 600;
const DEFAULT_PHASE_B_DURATION_MS = 120_000;
const DEFAULT_PHASE_B_WORKERS = 2;
const DEFAULT_BATCH_SIZE = 500;
const DRAIN_TIME_CAPS = [60, 300, 600, 1_200];

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}min`;
  return `${(m / 60).toFixed(1)}h`;
}

async function runPhaseA(opts: {
  db: Db;
  transport: Transporter;
  from: string;
  n: number;
  concurrencies: number[];
  batchSize: number;
  /** The in-process sink's own message list, when one is running (omitted for an external
   * `--smtp` target) — cross-checked against `delivered`/`n` per concurrency, not just
   * trusted from sendDue's own result. */
  sink?: { messages: ParsedMail[] };
}): Promise<PhaseARow[]> {
  const rows: PhaseARow[] = [];
  for (const concurrency of opts.concurrencies) {
    // One rate-window row per wall-clock minute shared by every call in this script; the cap
    // here (1,000,000/min) is set so high it can never bind, so Phase A measures the sender and
    // transport, not the cap.
    const queuedAddresses = await queueRecipients(opts.db, opts.n, `a-${concurrency}`);
    const sinkStartIndex = opts.sink?.messages.length ?? 0;
    const start = performance.now();
    let delivered = 0;
    while (true) {
      const result = await sendDue({
        db: opts.db,
        transport: opts.transport,
        from: opts.from,
        redirectTo: [],
        ratePerMinute: 1_000_000,
        concurrency,
        batchSize: opts.batchSize,
      });
      delivered += result.sent;
      if (result.sent === 0 && result.retried === 0 && result.failed === 0) break;
      if (result.retried > 0 || result.failed > 0) {
        throw new Error(
          `distribution-capacity: expected every send to the local sink to succeed, but concurrency ${concurrency} saw ${result.retried} retried and ${result.failed} failed`,
        );
      }
    }
    const elapsedMs = performance.now() - start;
    const pending = await countPending(opts.db);
    if (pending !== 0) {
      throw new Error(`distribution-capacity: ${pending} messages still pending after draining at concurrency ${concurrency}`);
    }

    // Don't just trust sendDue's own "sent" count — cross-check what the sink actually
    // recorded. Catches, for instance, a transport that silently drops a message after
    // nodemailer resolves its sendMail() promise, which `delivered` alone could never see.
    let sinkReceived: number | null = null;
    let duplicateRecipients = 0;
    if (opts.sink) {
      const receivedAddresses = opts.sink.messages.slice(sinkStartIndex).map(addressOf).filter((a): a is string => a !== undefined);
      sinkReceived = receivedAddresses.length;
      duplicateRecipients = receivedAddresses.length - new Set(receivedAddresses).size;
      if (sinkReceived !== delivered || sinkReceived !== opts.n) {
        throw new Error(
          `distribution-capacity: sink received ${sinkReceived} message(s) at concurrency ${concurrency}, but sendDue reported ${delivered} sent and ${opts.n} were queued — these must all agree`,
        );
      }
      if (duplicateRecipients > 0) {
        throw new Error(`distribution-capacity: sink received ${duplicateRecipients} duplicate recipient(s) at concurrency ${concurrency}`);
      }
      const queuedSet = new Set(queuedAddresses);
      const unexpected = receivedAddresses.filter((a) => !queuedSet.has(a));
      if (unexpected.length > 0) {
        throw new Error(`distribution-capacity: sink received ${unexpected.length} message(s) to unexpected recipient(s) at concurrency ${concurrency}`);
      }
    }

    const sendsPerMinute = opts.n / (elapsedMs / 60_000);
    rows.push({ concurrency, elapsedMs, sendsPerMinute, delivered, sinkReceived, duplicateRecipients });
  }
  return rows;
}

async function runPhaseB(opts: {
  db: Db;
  transport: Transporter;
  from: string;
  capPerMinute: number;
  workers: number;
  durationMs: number;
  batchSize: number;
}): Promise<PhaseBResult> {
  // A fresh baseline: Phase A's own huge cap left send_rate_windows holding counts far above
  // capPerMinute for whichever minute(s) it ran in, which would make this phase's very first
  // claim see a budget already exhausted. Safe to clear outright — this is always a throwaway
  // database.
  await opts.db.execute(sql`TRUNCATE TABLE send_rate_windows`);
  // However many messages the cap could possibly claim across the whole run, plus headroom, so
  // the queue never runs dry before the duration does — that would silently turn this into "the
  // cap holds because there's nothing left to claim", not a real test of it.
  const queued = Math.ceil((opts.capPerMinute * opts.durationMs) / 60_000) * 2 + 100;
  await queueRecipients(opts.db, queued, "b");

  const runStart = performance.now();
  const dbRunStart = new Date();
  async function worker(): Promise<void> {
    while (performance.now() - runStart < opts.durationMs) {
      await sendDue({
        db: opts.db,
        transport: opts.transport,
        from: opts.from,
        redirectTo: [],
        ratePerMinute: opts.capPerMinute,
        concurrency: 1,
        batchSize: opts.batchSize,
      });
      await sleep(20);
    }
  }
  await Promise.all(Array.from({ length: opts.workers }, () => worker()));

  const windowRows = await opts.db
    .select({ windowStart: sendRateWindows.windowStart, claimed: sendRateWindows.claimed })
    .from(sendRateWindows)
    .where(sql`${sendRateWindows.windowStart} >= date_trunc('minute', ${dbRunStart.toISOString()}::timestamptz)`)
    .orderBy(sendRateWindows.windowStart);
  const windows: PhaseBWindow[] = windowRows.map((r) => ({ windowStart: r.windowStart.toISOString(), claimed: r.claimed }));
  if (windows.reduce((sum, w) => sum + w.claimed, 0) === 0) {
    throw new Error("distribution-capacity: Phase B claimed nothing at all — the measurement didn't exercise the cap");
  }
  const held = windows.every((w) => w.claimed <= opts.capPerMinute);
  return { capPerMinute: opts.capPerMinute, workers: opts.workers, durationMs: opts.durationMs, windows, held };
}

function buildMarkdown(opts: {
  n: number;
  machine: string;
  nodeVersion: string;
  postgresVersion: string;
  sink: string;
  phaseA: PhaseARow[];
  phaseB?: PhaseBResult;
}): string {
  const lines: string[] = [];
  lines.push(`Machine: ${opts.machine}`);
  lines.push(`Node: ${opts.nodeVersion}`);
  lines.push(`Postgres: ${opts.postgresVersion}`);
  lines.push(`SMTP sink: ${opts.sink}`);
  lines.push("");
  lines.push(`## Phase A: throughput (N=${opts.n})`);
  lines.push("");
  lines.push("| concurrency | elapsed | sends/min | delivered | sink-received |");
  lines.push("|---|---|---|---|---|");
  for (const row of opts.phaseA) {
    const sinkCell = row.sinkReceived === null ? "n/a (external SMTP target)" : row.duplicateRecipients > 0 ? `${row.sinkReceived} (${row.duplicateRecipients} dup!)` : `${row.sinkReceived}`;
    lines.push(`| ${row.concurrency} | ${formatDuration(row.elapsedMs)} | ${Math.round(row.sendsPerMinute).toLocaleString("en-US")} | ${row.delivered} | ${sinkCell} |`);
  }
  lines.push("");

  const baseline = opts.phaseA.find((r) => r.concurrency === 1) ?? opts.phaseA[0];
  if (baseline) {
    lines.push(`## Drain time for N=${opts.n}, by cap (computed from concurrency ${baseline.concurrency}'s measured throughput, not waited out)`);
    lines.push("");
    lines.push("| cap (msgs/min) | drain time |");
    lines.push("|---|---|");
    for (const cap of DRAIN_TIME_CAPS) {
      const effectiveRate = Math.min(cap, baseline.sendsPerMinute);
      const drainMs = (opts.n / effectiveRate) * 60_000;
      lines.push(`| ${cap.toLocaleString("en-US")} | ${formatDuration(drainMs)} |`);
    }
    lines.push("");
  }

  if (opts.phaseB) {
    const b = opts.phaseB;
    lines.push(`## Phase B: cap holds (${b.capPerMinute}/min, ${b.workers} concurrent workers, ${formatDuration(b.durationMs)})`);
    lines.push("");
    lines.push("| window (minute) | claimed | <= cap? |");
    lines.push("|---|---|---|");
    for (const w of b.windows) {
      lines.push(`| ${w.windowStart} | ${w.claimed} | ${w.claimed <= b.capPerMinute ? "yes" : "NO"} |`);
    }
    lines.push("");
    lines.push(b.held ? "Cap held across every recorded minute." : "**Cap was exceeded in at least one minute.**");
    lines.push("");
  }

  return lines.join("\n");
}

async function describeMachine(db: Db): Promise<{ machine: string; postgresVersion: string }> {
  const { rows } = await db.execute<{ version: string }>(sql`SELECT version()`);
  return { machine: `${process.platform} ${process.arch}`, postgresVersion: rows[0]?.version ?? "unknown" };
}

export async function runCapacityMeasurement(opts: CapacityOptions = {}): Promise<CapacityResult> {
  const n = opts.n ?? DEFAULT_N;
  const concurrencies = opts.concurrencies ?? DEFAULT_CONCURRENCIES;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const runPhaseBFlag = opts.phaseB ?? true;
  const capPerMinute = opts.capPerMinute ?? DEFAULT_PHASE_B_CAP;
  const phaseBDurationMs = opts.phaseBDurationMs ?? DEFAULT_PHASE_B_DURATION_MS;
  const phaseBWorkers = opts.phaseBWorkers ?? DEFAULT_PHASE_B_WORKERS;

  if (!Number.isInteger(n) || n <= 0) throw new Error(`distribution-capacity: --n must be a positive integer (got ${n})`);
  if (concurrencies.length === 0 || concurrencies.some((c) => !Number.isInteger(c) || c <= 0)) {
    throw new Error(`distribution-capacity: --concurrencies must be a non-empty list of positive integers (got ${concurrencies.join(",")})`);
  }

  // There is no SMTP_HOST env var this script itself consults for the SMTP target — only
  // --smtp does that — so a check against process.env.SMTP_HOST validated a value that could
  // never steer where mail actually goes, a guard in name only. Removed rather than wired up,
  // since nothing here needs SMTP_HOST to mean anything.
  const target = opts.smtp ? parseSmtpTarget(opts.smtp) : null;
  // The real non-SMTP risk — createDistributionTestDb() creates/migrates/drops its database
  // against this URL, with no guard of its own.
  assertLocalDatabaseAdminTarget(effectiveDatabaseAdminUrl());

  const maxConcurrency = Math.max(...concurrencies, phaseBWorkers);
  let tdb: TestDatabase | undefined;
  let sink: Awaited<ReturnType<typeof startSmtpSink>> | undefined;
  let transport: Transporter | undefined;
  try {
    tdb = await createDistributionTestDb();
    const host = target?.host ?? "127.0.0.1";
    let port: number;
    let sinkLabel: string;
    if (target) {
      port = target.port;
      sinkLabel = `${target.host}:${target.port} (external, e.g. Mailpit)`;
    } else {
      sink = await startSmtpSink();
      port = sink.port;
      sinkLabel = `in-process smtp-server sink, 127.0.0.1:${sink.port}`;
    }
    transport = nodemailer.createTransport({ host, port, secure: false, ignoreTLS: true, pool: true, maxConnections: maxConcurrency });

    const { machine, postgresVersion } = await describeMachine(tdb.db);
    const phaseA = await runPhaseA({ db: tdb.db, transport, from: "news@example.test", n, concurrencies, batchSize, sink });
    const phaseB = runPhaseBFlag
      ? await runPhaseB({ db: tdb.db, transport, from: "news@example.test", capPerMinute, workers: phaseBWorkers, durationMs: phaseBDurationMs, batchSize })
      : undefined;

    const markdown = buildMarkdown({ n, machine, nodeVersion: process.version, postgresVersion, sink: sinkLabel, phaseA, phaseB });
    return { n, machine, nodeVersion: process.version, postgresVersion, sink: sinkLabel, phaseA, phaseB, markdown };
  } finally {
    await transport?.close();
    await sink?.close();
    await tdb?.drop();
  }
}

function parseArgs(argv: string[]): CapacityOptions {
  const opts: CapacityOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--n":
        opts.n = Number(argv[++i]);
        break;
      case "--smtp":
        opts.smtp = argv[++i];
        break;
      case "--concurrencies":
        opts.concurrencies = (argv[++i] ?? "").split(",").map((s) => Number(s.trim()));
        break;
      case "--skip-phase-b":
        opts.phaseB = false;
        break;
      case "--phase-b-cap":
        opts.capPerMinute = Number(argv[++i]);
        break;
      case "--phase-b-ms":
        opts.phaseBDurationMs = Number(argv[++i]);
        break;
      case "--phase-b-workers":
        opts.phaseBWorkers = Number(argv[++i]);
        break;
      case "--batch-size":
        opts.batchSize = Number(argv[++i]);
        break;
      default:
        throw new Error(`distribution-capacity: unrecognised argument "${arg}"`);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const result = await runCapacityMeasurement(opts);
  console.log(result.markdown);
  if (result.phaseB && !result.phaseB.held) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
