#!/usr/bin/env -S node --
// Undoes a scrub:test-data load: restores all seven boxs.ca databases and site-output from the
// backup the load took (~/gcpe-data/backups/<stamp> on boxs.ca). The operator stops and starts the
// app in Site Tools when asked; the command checks /stack/health each time.
//
// Usage: npm run scrub:test-data:restore -- <stamp> [--ssh-host boxs] [--site https://boxs.ca]
import { pathToFileURL } from "node:url";
import { safeErrorLabel } from "@gcpe/http-kit";
import { PromptEndedError, Prompter } from "./siteground-env";
import { BOXS_APPS, restoreScript, runRemote, STAMP_RE } from "./lib/scrub/boxs";
import { ScrubArgumentError, ScrubStepError } from "./lib/scrub/private-out";
import { stackHealthy, waitFor } from "./lib/scrub/smoke";

export const NOT_AT_A_TERMINAL = "the approval must be typed at a terminal: nothing on boxs.ca changed";

/** Errors whose messages are ours and carry no data, so they may be printed as they are. */
export const printable = (e: unknown): e is Error => e instanceof ScrubArgumentError || e instanceof ScrubStepError || e instanceof PromptEndedError;

export function parseRestoreArgs(argv: string[]): { stamp: string; sshHost: string; site: string } {
  let stamp: string | undefined;
  let sshHost = "boxs";
  let site = "https://boxs.ca";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--ssh-host") sshHost = argv[++i] ?? "";
    else if (a === "--site") site = (argv[++i] ?? "").replace(/\/+$/, "");
    else if (!a.startsWith("--") && stamp === undefined) stamp = a;
    else throw new ScrubArgumentError(`Unknown argument: ${a}`);
  }
  if (!stamp || !STAMP_RE.test(stamp)) throw new ScrubArgumentError("give the backup's stamp, YYYYMMDD-HHMMSS, as the load printed it");
  if (!/^[A-Za-z0-9._-]+$/.test(sshHost)) throw new ScrubArgumentError("--ssh-host must be an ssh host alias");
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(site)) throw new ScrubArgumentError("--site must be an https origin");
  return { stamp, sshHost, site };
}

/** A read-only look at the backup folder: the dumps and the site-output archive the restore will need. */
export function backupCheckScript(stamp: string): string {
  if (!STAMP_RE.test(stamp)) throw new ScrubArgumentError("a stamp is YYYYMMDD-HHMMSS");
  const files = [...BOXS_APPS.map((a) => `${a.app}.sql.gz`), "site-output.tar.gz"];
  return [`DIR="$HOME/gcpe-data/backups/${stamp}"`, `for f in ${files.join(" ")}; do [ -s "$DIR/$f" ] || { echo missing; exit 0; }; done`, "echo ok", ""].join("\n");
}

export interface RestoreDeps {
  isTTY: boolean;
  ask(label: string): Promise<string>;
  backupReady(): Promise<boolean>;
  stopped(): Promise<boolean>;
  restore(): Promise<void>;
  started(): Promise<boolean>;
  log(line: string): void;
}

export async function runRestore(o: { stamp: string; host: string }, d: RestoreDeps): Promise<void> {
  if (!d.isTTY) throw new ScrubStepError(NOT_AT_A_TERMINAL);
  // Checked before the operator stops anything: a mistyped stamp shouldn't cost the site its uptime.
  if (!(await d.backupReady())) throw new ScrubStepError(`backup ${o.stamp} isn't on ${o.host} or is incomplete: nothing changed`);
  if ((await d.ask(`Type "restore ${o.stamp}" to put ${o.host} back as it was at that backup`)) !== `restore ${o.stamp}`) throw new ScrubStepError("not confirmed: nothing changed");
  await d.ask(`Stop the ${o.host} Node.js app in Site Tools, then press Enter`);
  if (!(await d.stopped())) throw new ScrubStepError(`${o.host} still answers: stop it in Site Tools first. Nothing changed`);
  try {
    await d.restore();
    await d.ask(`Start the ${o.host} Node.js app in Site Tools, then press Enter`);
  } catch (e) {
    throw new ScrubStepError(`${printable(e) ? e.message : safeErrorLabel(e)}: start the app again in Site Tools`);
  }
  if (!(await d.started())) throw new ScrubStepError(`${o.host} isn't healthy after the restore: check /hub/error-log`);
  d.log(`Restored ${o.host} from backup ${o.stamp}.`);
}

async function main(): Promise<void> {
  const o = parseRestoreArgs(process.argv.slice(2));
  const prompt = new Prompter();
  try {
    await runRestore({ stamp: o.stamp, host: new URL(o.site).host }, {
      isTTY: Boolean(process.stdin.isTTY),
      ask: (label) => prompt.plain(label, ""),
      backupReady: async () => (await runRemote(o.sshHost, backupCheckScript(o.stamp), { capture: true })).trim() === "ok",
      stopped: () => waitFor(async () => !(await stackHealthy(o.site)), { timeoutMs: 300_000, everyMs: 5_000 }),
      restore: async () => { await runRemote(o.sshHost, restoreScript({ stamp: o.stamp, from: "backups", apps: BOXS_APPS.map((a) => a.app), resetNodPositions: false, siteOutput: "restore" })); },
      started: () => waitFor(() => stackHealthy(o.site), { timeoutMs: 600_000, everyMs: 10_000 }),
      log: (line) => console.log(line),
    });
  } finally {
    prompt.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (e) {
    console.error(printable(e) ? e.message : safeErrorLabel(e));
    process.exitCode = 1;
  }
}
