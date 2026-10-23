#!/usr/bin/env -S node --
// Undoes a scrub:test-data load: restores all seven boxs.ca databases and site-output from the
// backup the load took (~/gcpe-data/backups/<stamp> on boxs.ca). The operator stops and starts the
// app in Site Tools when asked; the command checks /stack/health each time.
//
// Usage: npm run scrub:test-data:restore -- <stamp> [--ssh-host boxs] [--site https://boxs.ca]
import { pathToFileURL } from "node:url";
import { safeErrorLabel } from "@gcpe/http-kit";
import { Prompter } from "./siteground-env";
import { BOXS_APPS, restoreScript, runRemote, STAMP_RE } from "./lib/scrub/boxs";
import { ScrubArgumentError, ScrubStepError } from "./lib/scrub/private-out";
import { stackHealthy, waitFor } from "./lib/scrub/smoke";

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

async function main(): Promise<void> {
  const o = parseRestoreArgs(process.argv.slice(2));
  const host = new URL(o.site).host;
  const prompt = new Prompter();
  try {
    if ((await prompt.plain(`Type "restore ${o.stamp}" to put ${host} back as it was at that backup`, "")) !== `restore ${o.stamp}`) throw new ScrubStepError("not confirmed: nothing changed");
    await prompt.plain(`Stop the ${host} Node.js app in Site Tools, then press Enter`, "");
    if (!(await waitFor(async () => !(await stackHealthy(o.site)), { timeoutMs: 300_000, everyMs: 5_000 }))) throw new ScrubStepError(`${host} still answers: stop it in Site Tools first. Nothing changed`);
    await runRemote(o.sshHost, restoreScript({ stamp: o.stamp, from: "backups", apps: BOXS_APPS.map((a) => a.app), resetNodPositions: false, siteOutput: "restore" }));
    await prompt.plain(`Start the ${host} Node.js app in Site Tools, then press Enter`, "");
    if (!(await waitFor(() => stackHealthy(o.site), { timeoutMs: 600_000, everyMs: 10_000 }))) throw new ScrubStepError(`${host} isn't healthy after the restore: check /hub/error-log`);
    console.log(`Restored ${host} from backup ${o.stamp}.`);
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
