#!/usr/bin/env -S node --
// Scrubbed legacy test data for boxs.ca (docs/deploy/siteground.md, "Refreshing test data from a
// legacy backup"). Restores a legacy backup as a *_Scrubbed copy, pseudonymises people, keeps only
// ended non-confidential activities and published releases, shifts calendar dates, checks for
// leaks on SQL Server and Postgres, imports and trials it locally, then, after typed approval,
// backs up boxs.ca and replaces its calendar, release and public-site data.
//
// Usage: npm run scrub:test-data -- --backup /backup/<file>.bak --out ~/gcpe-parity-private/scrub [--stop-after trial]
// Everything real stays under --out. It prints step names, table and column names and counts only.
import { statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { withAdmin } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";
import { Prompter } from "./siteground-env";
import { parseScrubArgs, STEPS, type ScrubOptions, type Step } from "./lib/scrub/args";
import { BOXS_APPS, backupScript, downloadBackup, localDump, restoreScript, runRemote, testAccountsScript, tickScript, uploadFile } from "./lib/scrub/boxs";
import { bcToday, wallClockOf } from "./lib/scrub/dates";
import { importSteps, legacyEnv, LOCAL_DB_NAMES, parseTestAccounts, recreateLocalDbs, runStep, seedTestAccounts, signInEmails, type LocalApp, type TestAccounts } from "./lib/scrub/local";
import { applyScope, assertRequiredTables, emptyTables, mssqlConfigFromEnv, openPool, restoreScrubCopy, shiftCalendarDates, tableCounts } from "./lib/scrub/mssql";
import { gateMssql, readPeopleSources, scrubAllText, writeStructuredPeople, type GateResult } from "./lib/scrub/mssql-text";
import { buildPeopleIndex, mappingCsv, type PeopleIndex } from "./lib/scrub/people";
import { gatePostgres } from "./lib/scrub/pg-gate";
import { loadOrCreateKey, preparePrivateDir, PRIVATE_ROOT, runStamp, ScrubArgumentError, ScrubStepError, withPrivateUmask, writePrivate } from "./lib/scrub/private-out";
import { loginWithPassword, runSmoke, stackHealthy, waitFor, type SmokeCheck } from "./lib/scrub/smoke";
import { runTrial, type TrialResult } from "./lib/scrub/trial";

export interface GateOutcome { passed: boolean; lines: string[] }
export interface ScrubSummary { weeks: number; people: number; lines: string[] }
export interface PipelineDeps {
  copy(): Promise<void>;
  scrub(): Promise<ScrubSummary>;
  gate1(): Promise<GateOutcome>;
  importAll(): Promise<void>;
  gate2(label: string): Promise<GateOutcome>;
  trial(): Promise<TrialResult>;
  approve(lines: string[]): Promise<boolean>;
  backup(): Promise<string>;
  load(backupStamp: string): Promise<SmokeCheck[]>;
  log(line: string): void;
}
export type PipelineOutcome = { status: "done" | "stopped"; at: Step } | { status: "failed"; at: Step; reason: string };

export async function runPipeline(stopAfter: Step, d: PipelineDeps): Promise<PipelineOutcome> {
  const stop = (s: Step) => STEPS.indexOf(s) >= STEPS.indexOf(stopAfter);
  const lines: string[] = [];
  const gate = (o: GateOutcome, at: Step, what: string): PipelineOutcome | null => {
    for (const l of o.lines) d.log(`  ${l}`);
    lines.push(`${what}: ${o.passed ? "passed" : "FAILED"}`);
    return o.passed ? null : { status: "failed", at, reason: `the ${what} found hits` };
  };
  await d.copy();
  if (stop("copy")) return { status: "stopped", at: "copy" };
  const summary = await d.scrub();
  lines.push(...summary.lines, `date offset: ${summary.weeks} weeks`, `people pseudonymised: ${summary.people}`);
  if (stop("scrub")) return { status: "stopped", at: "scrub" };
  const g1 = gate(await d.gate1(), "gate1", "SQL Server leak check");
  if (g1) return g1;
  if (stop("gate1")) return { status: "stopped", at: "gate1" };
  await d.importAll();
  if (stop("import")) return { status: "stopped", at: "import" };
  const g2 = gate(await d.gate2("after import"), "gate2", "Postgres leak check");
  if (g2) return g2;
  if (stop("gate2")) return { status: "stopped", at: "gate2" };
  const trial = await d.trial();
  for (const c of trial.smoke) d.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
  if (!trial.smoke.every((c) => c.ok)) return { status: "failed", at: "trial", reason: "the local smoke test failed" };
  const g3 = gate(await d.gate2("after trial"), "trial", "Postgres leak check after the trial");
  if (g3) return g3;
  lines.push(`local trial: ${trial.ticks} ticks, smoke test passed`);
  if (stop("trial")) return { status: "stopped", at: "trial" };
  if (!(await d.approve(lines))) return { status: "failed", at: "approve", reason: "not approved" };
  const backupStamp = await d.backup();
  d.log(`boxs.ca backup: ${backupStamp} (undo with npm run scrub:test-data:restore -- ${backupStamp})`);
  if (stop("backup")) return { status: "stopped", at: "backup" };
  const smoke = await d.load(backupStamp);
  for (const c of smoke) d.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
  return smoke.every((c) => c.ok) ? { status: "done", at: "load" } : { status: "failed", at: "load", reason: `the boxs.ca smoke test failed: undo with npm run scrub:test-data:restore -- ${backupStamp}` };
}

/**
 * What a gate shows on the console: table, column, kind and count per hit, and how many public office holders'
 * names were seen. The row ids can be real key values (an email-keyed row), so they go only to the private report.
 */
export function gateOutcome(g: GateResult & { signInProblems?: number }): GateOutcome {
  const signIn = g.signInProblems ?? 0;
  return {
    passed: g.hits.length === 0 && signIn === 0,
    lines: [
      ...g.hits.map((h) => `${h.table}.${h.column} ${h.kind}: ${h.count}`),
      ...(g.publicOfficeHits > 0 ? [`public office holders' names (reported, not a failure): ${g.publicOfficeHits}`] : []),
      ...(signIn > 0 ? [`users who could sign in but aren't test accounts: ${signIn}`] : []),
    ],
  };
}

/** The databases boxs.ca receives. Core is scanned like the rest: its users and organisations came from legacy too. */
export function pgGateDbs(urls: Record<LocalApp, string>): { name: string; url: string }[] {
  return BOXS_APPS.filter((a) => a.replaced).map((a) => ({ name: a.local, url: urls[a.local] }));
}

/** Checks --out and the key file against the private root before anything is read or written. */
export function prepareRun(o: Pick<ScrubOptions, "out" | "keyFile">, stamp: string, root = PRIVATE_ROOT): { out: string; key: string } {
  preparePrivateDir(o.out, root);
  const out = preparePrivateDir(join(o.out, stamp), root);
  return { out, key: loadOrCreateKey(o.keyFile, root) };
}

const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

async function localSizes(): Promise<string[]> {
  const names = BOXS_APPS.filter((a) => a.replaced).map((a) => LOCAL_DB_NAMES[a.local]);
  const rows = await withAdmin(async (c) => (await c.query<{ name: string; size: string }>("SELECT datname AS name, pg_database_size(datname)::text AS size FROM pg_database WHERE datname = ANY($1::text[]) ORDER BY datname", [names])).rows);
  const total = rows.reduce((s, r) => s + Number(r.size), 0);
  return [...rows.map((r) => `local ${r.name}: ${mb(Number(r.size))}`), `local databases to upload, in total: ${mb(total)} (check Site Tools' storage meter has room)`];
}

async function main(): Promise<void> {
  const opts = parseScrubArgs(process.argv.slice(2));
  const stamp = runStamp();
  const { out, key } = prepareRun(opts, stamp);
  const cfg = mssqlConfigFromEnv();
  const refUtc = new Date();
  const refWall = wallClockOf(refUtc, "America/Vancouver");
  const host = new URL(opts.site).host;
  const prompt = new Prompter();
  const log = (line: string) => console.log(line);
  let index: PeopleIndex | null = null;
  let accounts: TestAccounts | null = null;
  let urls: Record<LocalApp, string> | null = null;
  const need = <T>(v: T | null, what: string): T => { if (v === null) throw new ScrubStepError(`${what} isn't ready: run the earlier steps first`); return v; };
  const scrubPool = () => openPool(cfg, opts.scrubbedDb);

  const deps: PipelineDeps = {
    log,
    async copy() {
      const master = await openPool(cfg, "master");
      try { await restoreScrubCopy(master, opts.backup, opts.scrubbedDb); } finally { await master.close(); }
      log(`Restored the backup as ${opts.scrubbedDb}.`);
    },
    async scrub() {
      // Read only: the test accounts' emails are reserved so no fictional email collides with one.
      accounts = parseTestAccounts(await runRemote(opts.sshHost, testAccountsScript(), { capture: true }));
      writePrivate(join(out, "test-accounts.json"), JSON.stringify(accounts));
      log(`Downloaded ${accounts.users.length} test accounts from ${host}.`);
      const pool = await scrubPool();
      try {
        await assertRequiredTables(pool);
        const before = await tableCounts(pool);
        // Indexed before scope and emptying, so people only in removed rows are still found in the rows kept.
        index = buildPeopleIndex(await readPeopleSources(pool), key, signInEmails(accounts));
        writePrivate(join(out, "mapping.csv"), mappingCsv(index));
        await applyScope(pool, refUtc, refWall);
        const emptied = await emptyTables(pool);
        const structured = await writeStructuredPeople(pool, index);
        const text = await scrubAllText(pool, { index, key }, log);
        writePrivate(join(out, "reports", "text-scrub.json"), JSON.stringify(text, null, 2));
        const dates = await shiftCalendarDates(pool, refWall, opts.leadDays);
        const after = await tableCounts(pool);
        const kept = (t: string) => `${t}: ${after[t] ?? 0} of ${before[t] ?? 0} kept`;
        return {
          weeks: dates.weeks,
          people: index.persons.length,
          lines: [kept("calendar.Activity"), kept("dbo.NewsRelease"), kept("calendar.Log"), kept("dbo.NewsReleaseLog"), `tables emptied: ${emptied.length}`, `people rows rewritten: ${structured}`, `log dates shifted: ${dates.logText.shifted}, left as they were: ${dates.logText.unparsed}`, `created/updated stamps moved back to now: ${dates.clamped}`],
        };
      } finally {
        await pool.close();
      }
    },
    async gate1() {
      const pool = await scrubPool();
      try {
        const g = await gateMssql(pool, need(index, "the people list"), log);
        writePrivate(join(out, "reports", "gate1.json"), JSON.stringify(g, null, 2));
        return gateOutcome(g);
      } finally {
        await pool.close();
      }
    },
    async importAll() {
      urls = await recreateLocalDbs();
      const steps = importSteps(urls, legacyEnv(cfg, opts.scrubbedDb), { out, cutoff: opts.calendarCutoff });
      const run = async (i: number) => {
        const s = steps[i]!;
        log(`Importing ${s.name}…`);
        const code = await runStep(s, join(out, "logs", `import-${s.name}.log`));
        if (code !== 0) throw new ScrubStepError(`the ${s.name} import exited ${code}: see logs/import-${s.name}.log under the run folder`);
      };
      await run(0);
      const seeded = await seedTestAccounts(urls.core, need(accounts, "the test accounts"));
      log(`Seeded ${seeded.users} test accounts.`);
      for (let i = 1; i < steps.length; i++) await run(i);
    },
    async gate2(label) {
      const local = need(urls, "the local databases");
      const g = await gatePostgres(pgGateDbs(local), need(index, "the people list"), { coreUrl: local.core, signInAllowed: signInEmails(need(accounts, "the test accounts")) });
      writePrivate(join(out, "reports", `gate2-${label.replace(/\W+/g, "-")}.json`), JSON.stringify(g, null, 2));
      return gateOutcome(g);
    },
    async trial() {
      return runTrial({ urls: need(urls, "the local databases"), out, calendarUser: opts.calendarUser, releaseUser: opts.releaseUser, log });
    },
    async approve(lines) {
      for (const l of [...lines, ...(await localSizes())]) log(l);
      const answer = await prompt.plain(`Type "load ${host}" to back up ${host} and replace its calendar, release and public-site data`, "");
      return answer === `load ${host}`;
    },
    async backup() {
      const b = runStamp();
      await runRemote(opts.sshHost, backupScript(b));
      await downloadBackup(opts.sshHost, b, join(out, `boxs-backup-${b}.tar`));
      return b;
    },
    async load(backupStamp) {
      const local = need(urls, "the local databases");
      const replaced = BOXS_APPS.filter((a) => a.replaced);
      for (const a of replaced) {
        const file = join(out, "dumps", `${a.app}.sql.gz`);
        await localDump(local[a.local], file);
        log(`Dumped ${a.app}: ${mb(statSync(file).size)} compressed.`);
        await uploadFile(opts.sshHost, file, stamp, `${a.app}.sql.gz`);
        log(`Uploaded ${a.app}.`);
      }
      await prompt.plain(`Stop the ${host} Node.js app in Site Tools (Devs → Node.js), then press Enter`, "");
      if (!(await waitFor(async () => !(await stackHealthy(opts.site)), { timeoutMs: 300_000, everyMs: 5_000 }))) throw new ScrubStepError(`${host} still answers: stop it in Site Tools first. Nothing was replaced; backup ${backupStamp} is ready`);
      await runRemote(opts.sshHost, restoreScript({ stamp, from: "scrub-load", apps: replaced.map((a) => a.app), resetNodPositions: true, siteOutput: "clear" }));
      await prompt.plain(`Start the ${host} Node.js app in Site Tools, then press Enter`, "");
      if (!(await waitFor(() => stackHealthy(opts.site), { timeoutMs: 600_000, everyMs: 10_000 }))) throw new ScrubStepError(`${host} isn't healthy: undo with npm run scrub:test-data:restore -- ${backupStamp}`);
      const adminUser = await prompt.plain("Break-glass admin user name", "admin");
      const tokenRes = await fetch(`${opts.site}/nrms/auth/local/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: adminUser, password: await prompt.hidden("Break-glass admin password: ") }) });
      const token = ((await tokenRes.json()) as { access_token?: string }).access_token;
      if (!token) throw new ScrubStepError("the break-glass sign-in failed");
      for (const path of ["/core/api/admin/republish", "/nrms/api/media-lists/republish"]) {
        const r = await fetch(`${opts.site}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
        if (!r.ok) throw new ScrubStepError(`${path} answered HTTP ${r.status}`);
      }
      await runRemote(opts.sshHost, tickScript(opts.site, 6));
      const calendarCookie = await loginWithPassword(opts.site, opts.calendarUser, await prompt.hidden(`Password for ${opts.calendarUser}: `));
      const releaseCookie = await loginWithPassword(opts.site, opts.releaseUser, await prompt.hidden(`Password for ${opts.releaseUser}: `));
      return runSmoke({ base: opts.site, calendarCookie, releaseCookie, today: bcToday() });
    },
  };

  try {
    const outcome = await withPrivateUmask(() => runPipeline(opts.stopAfter, deps));
    if (outcome.status === "failed") { console.error(`Stopped at ${outcome.at}: ${outcome.reason}.`); process.exitCode = 1; }
    else console.log(outcome.status === "done" ? `Loaded ${host}. Run folder: ${out}` : `Stopped after ${outcome.at}, as asked. Run folder: ${out}`);
  } finally {
    prompt.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (e) {
    console.error(e instanceof ScrubArgumentError || e instanceof ScrubStepError ? e.message : safeErrorLabel(e));
    process.exitCode = 1;
  }
}
