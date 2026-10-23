import { join, resolve } from "node:path";
import { bcDateSchema } from "@gcpe/calendar-contract";
import { PRIVATE_ROOT, ScrubArgumentError, strictlyInside } from "./private-out";

export const STEPS = ["copy", "scrub", "gate1", "import", "gate2", "trial", "approve", "backup", "load"] as const;
export type Step = (typeof STEPS)[number];

export interface ScrubOptions {
  /** The .bak path as SQL Server sees it (in the local container, /backup/<file>.bak). */
  backup: string;
  out: string;
  keyFile: string;
  scrubbedDb: string;
  calendarCutoff: string;
  site: string;
  sshHost: string;
  stopAfter: Step;
  calendarUser: string;
  releaseUser: string;
  leadDays: number;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseScrubArgs(argv: string[], privateRoot = PRIVATE_ROOT): ScrubOptions {
  const o: Partial<Record<string, string>> = {};
  const flags = ["--backup", "--out", "--key-file", "--scrubbed-db", "--calendar-cutoff", "--site", "--ssh-host", "--stop-after", "--calendar-user", "--release-user"];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!flags.includes(a)) throw new ScrubArgumentError(`Unknown argument: ${a}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) throw new ScrubArgumentError(`${a} needs a value`);
    o[a] = v;
  }
  const backup = o["--backup"];
  if (!backup) throw new ScrubArgumentError("--backup <file> is required: the .bak path as SQL Server sees it");
  if (!/^\/[A-Za-z0-9_./-]+\.bak$/.test(backup) || backup.split("/").includes("..")) throw new ScrubArgumentError("--backup must be an absolute .bak path of letters, digits, _ . / and - only");
  const out = o["--out"];
  if (!out) throw new ScrubArgumentError("--out <folder> is required");
  const scrubbedDb = o["--scrubbed-db"] ?? "Gcpe.Hub_Scrubbed";
  if (!/^[A-Za-z0-9_.]+_Scrubbed$/.test(scrubbedDb)) throw new ScrubArgumentError("--scrubbed-db must end in _Scrubbed");
  const calendarCutoff = o["--calendar-cutoff"] ?? "2000-01-01";
  if (!bcDateSchema.safeParse(calendarCutoff).success) throw new ScrubArgumentError("--calendar-cutoff must be a real date, YYYY-MM-DD");
  const site = (o["--site"] ?? "https://boxs.ca").replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(site); } catch { throw new ScrubArgumentError("--site must be an https origin"); }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) throw new ScrubArgumentError("--site must be an https origin");
  const sshHost = o["--ssh-host"] ?? "boxs";
  if (!/^[A-Za-z0-9._-]+$/.test(sshHost)) throw new ScrubArgumentError("--ssh-host must be an ssh host alias");
  const stopAfter = (o["--stop-after"] ?? "load") as Step;
  if (!STEPS.includes(stopAfter)) throw new ScrubArgumentError(`--stop-after must be one of: ${STEPS.join(", ")}`);
  const calendarUser = o["--calendar-user"] ?? "cal-hq-editor@example.test";
  if (!EMAIL.test(calendarUser)) throw new ScrubArgumentError("--calendar-user must be an email address");
  const releaseUser = o["--release-user"] ?? "editor@example.test";
  if (!EMAIL.test(releaseUser)) throw new ScrubArgumentError("--release-user must be an email address");
  const keyFile = resolve(o["--key-file"] ?? join(privateRoot, "scrub-key"));
  if (!strictlyInside(privateRoot, keyFile)) throw new ScrubArgumentError("--key-file must be inside the private root");
  return { backup, out: resolve(out), keyFile, scrubbedDb, calendarCutoff, site, sshHost, stopAfter, calendarUser, releaseUser, leadDays: 14 };
}
