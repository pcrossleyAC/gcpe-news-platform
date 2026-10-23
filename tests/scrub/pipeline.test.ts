import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Step } from "../../scripts/lib/scrub/args";
import type { LocalApp } from "../../scripts/lib/scrub/local";
import type { PgGateResult } from "../../scripts/lib/scrub/pg-gate";
import { ScrubStepError } from "../../scripts/lib/scrub/private-out";
import { PromptEndedError } from "../../scripts/siteground-env";
import { backupCheckScript, NOT_AT_A_TERMINAL, parseRestoreArgs, runRestore, type RestoreDeps } from "../../scripts/scrub-test-data-restore";
import { approveLoad, checkSecrets, gateOutcome, pgGateDbs, prepareRun, runPipeline, type Asker, type PipelineDeps } from "../../scripts/scrub-test-data";

function deps(over: Partial<PipelineDeps> = {}): { d: PipelineDeps; calls: string[] } {
  const calls: string[] = [];
  const pass = { passed: true, lines: [] };
  const d: PipelineDeps = {
    copy: async () => { calls.push("copy"); },
    scrub: async () => { calls.push("scrub"); return { weeks: 3, people: 2, lines: ["3 weeks"] }; },
    gate1: async () => { calls.push("gate1"); return pass; },
    importAll: async () => { calls.push("import"); },
    gate2: async (label) => { calls.push(`gate2:${label}`); return pass; },
    trial: async () => { calls.push("trial"); return { ticks: 4, smoke: [{ name: "calendar list", ok: true, detail: "12" }] }; },
    approve: async () => { calls.push("approve"); return true; },
    backup: async () => { calls.push("backup"); return "20261022-120000"; },
    load: async (s) => { calls.push(`load:${s}`); return [{ name: "public home page", ok: true, detail: "ok" }]; },
    log: () => {},
    ...over,
  };
  return { d, calls };
}

describe("runPipeline", () => {
  it("runs every step in order", async () => {
    const { d, calls } = deps();
    expect(await runPipeline("load", d)).toEqual({ status: "done", at: "load" });
    expect(calls).toEqual(["copy", "scrub", "gate1", "import", "gate2:after import", "trial", "gate2:after trial", "approve", "backup", "load:20261022-120000"]);
  });

  it("stops at the first failed gate", async () => {
    const { d, calls } = deps({ gate1: async () => ({ passed: false, lines: ["calendar.Activity.Comments name: 1"] }) });
    expect(await runPipeline("load", d)).toEqual({ status: "failed", at: "gate1", reason: "the SQL Server leak check found hits" });
    expect(calls).toEqual(["copy", "scrub"]);
  });

  it("stops when the trial's smoke test fails", async () => {
    const { d, calls } = deps({ trial: async () => ({ ticks: 1, smoke: [{ name: "look ahead pdf", ok: false, detail: "not a PDF" }] }) });
    expect((await runPipeline("load", d)).status).toBe("failed");
    expect(calls).not.toContain("approve");
  });

  it.each<[Step, string]>([["copy", "copy"], ["gate1", "gate1"], ["trial", "gate2:after trial"]])("stops after %s when asked", async (step, last) => {
    const { d, calls } = deps();
    expect(await runPipeline(step, d)).toEqual({ status: "stopped", at: step });
    expect(calls[calls.length - 1]).toBe(last);
  });

  it("never touches boxs.ca without approval", async () => {
    const { d, calls } = deps({ approve: async () => false });
    expect(await runPipeline("load", d)).toEqual({ status: "failed", at: "approve", reason: "not approved" });
    expect(calls).not.toContain("backup");
  });

  it("stops at Gate 2 after the trial without asking for approval", async () => {
    const { d, calls } = deps({ gate2: async (label) => { calls.push(`gate2:${label}`); return { passed: label !== "after trial", lines: [] }; } });
    expect(await runPipeline("load", d)).toEqual({ status: "failed", at: "trial", reason: "the Postgres leak check after the trial found hits" });
    expect(calls).not.toContain("approve");
  });

  it("stops at a failed Gate 2 after import, before the trial", async () => {
    const { d, calls } = deps({ gate2: async (label) => { calls.push(`gate2:${label}`); return { passed: false, lines: [] }; } });
    expect(await runPipeline("load", d)).toEqual({ status: "failed", at: "gate2", reason: "the Postgres leak check found hits" });
    expect(calls).toEqual(["copy", "scrub", "gate1", "import", "gate2:after import"]);
  });

  it.each<[Step, string]>([["approve", "approve"], ["backup", "backup"]])("--stop-after %s goes no further than %s", async (step, last) => {
    const { d, calls } = deps();
    expect(await runPipeline(step, d)).toEqual({ status: "stopped", at: step });
    expect(calls[calls.length - 1]).toBe(last);
  });

  it("an approval refused for want of a terminal never reaches the backup", async () => {
    const asked: string[] = [];
    const ask: Asker = { plain: async (l) => { asked.push(l); return "load boxs.ca"; }, hidden: async (l) => { asked.push(l); return "fictional"; } };
    const { d, calls } = deps({ approve: async () => (await approveLoad({ isTTY: false, ask, host: "boxs.ca", calendarUser: "cal@example.test", releaseUser: "rel@example.test" })) !== null });
    await expect(runPipeline("load", d)).rejects.toThrow(NOT_AT_A_TERMINAL);
    expect(calls).not.toContain("backup");
    expect(asked).toEqual([]);
  });

  it("shows the operator every summary line before asking", async () => {
    let shown: string[] = [];
    const { d } = deps({ approve: async (lines) => { shown = lines; return false; } });
    await runPipeline("load", d);
    expect(shown).toEqual(["3 weeks", "date offset: 3 weeks", "people pseudonymised: 2", "SQL Server leak check: passed", "Postgres leak check: passed", "Postgres leak check after the trial: passed", "local trial: 4 ticks, smoke test passed"]);
  });
});

const gate = (over: Partial<PgGateResult> = {}): PgGateResult => ({ hits: [], rows: [], publicOffice: [], publicOfficeHits: 0, signInProblems: 0, ...over });

describe("gateOutcome", () => {
  it("passes with public office mentions and prints only their count", () => {
    const o = gateOutcome(gate({ publicOffice: [{ table: "calendar.Activity", column: "Details", kind: "literal-name", count: 3 }], publicOfficeHits: 3 }));
    expect(o).toEqual({ passed: true, lines: ["public office holders' names (reported, not a failure): 3"] });
  });

  it("fails on hits and prints table, column, kind and count but never a row id", () => {
    const o = gateOutcome(gate({ hits: [{ table: "dbo.NewsRelease", column: "Summary", kind: "literal-email", count: 2 }], rows: [{ table: "dbo.NewsRelease", column: "Summary", kind: "literal-email", id: "quill.ashbury@gov.example" }] }));
    expect(o.passed).toBe(false);
    expect(o.lines).toEqual(["dbo.NewsRelease.Summary literal-email: 2"]);
    expect(o.lines.join("\n")).not.toContain("quill.ashbury");
  });

  it("fails on users who could sign in but aren't test accounts", () => {
    expect(gateOutcome(gate({ signInProblems: 1 }))).toEqual({ passed: false, lines: ["users who could sign in but aren't test accounts: 1"] });
  });

  it("reads a SQL Server result, which has no sign-in count", () => {
    const { signInProblems: _, ...mssql } = gate();
    expect(gateOutcome(mssql).passed).toBe(true);
  });
});

describe("pgGateDbs", () => {
  it("scans Core's own database as well as the other replaced ones", () => {
    const urls = Object.fromEntries((["core", "nrms", "newsApi", "site", "calendar", "nod", "distribution"] as const).map((k) => [k, `postgres://localhost/${k}`])) as Record<LocalApp, string>;
    expect(pgGateDbs(urls)).toEqual([
      { name: "core", url: "postgres://localhost/core" },
      { name: "nrms", url: "postgres://localhost/nrms" },
      { name: "newsApi", url: "postgres://localhost/newsApi" },
      { name: "site", url: "postgres://localhost/site" },
      { name: "calendar", url: "postgres://localhost/calendar" },
    ]);
  });
});

describe("prepareRun", () => {
  let root = "";
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ""; });
  const fresh = () => (root = mkdtempSync(join(tmpdir(), "scrub-run-")));

  it("makes the run folder inside --out, both private, and keeps the key inside the private root", () => {
    const r = fresh();
    const run = prepareRun({ out: join(r, "scrub"), keyFile: join(r, "scrub-key") }, "20261022-120000", r);
    expect(run.out.endsWith(join("scrub", "20261022-120000"))).toBe(true);
    expect(statSync(join(r, "scrub")).mode & 0o777).toBe(0o700);
    expect(statSync(run.out).mode & 0o777).toBe(0o700);
    expect(run.key).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(r, "scrub-key")).mode & 0o777).toBe(0o600);
  });

  it("refuses an --out outside the private root before creating anything", () => {
    const r = fresh();
    const outside = mkdtempSync(join(tmpdir(), "scrub-outside-"));
    try {
      expect(() => prepareRun({ out: join(outside, "scrub"), keyFile: join(r, "scrub-key") }, "20261022-120000", r)).toThrow(/--out must be a folder inside/);
      expect(existsSync(join(outside, "scrub"))).toBe(false);
      expect(existsSync(join(r, "scrub-key"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a key file outside the private root", () => {
    const r = fresh();
    expect(() => prepareRun({ out: join(r, "scrub"), keyFile: join(tmpdir(), "scrub-key-elsewhere") }, "20261022-120000", r)).toThrow(/--key-file must be inside/);
  });
});

function asker(answers: Record<string, string>): { ask: Asker; asked: string[] } {
  const asked: string[] = [];
  const answer = async (l: string) => { asked.push(l); const k = Object.keys(answers).find((x) => l.startsWith(x)); return k === undefined ? "" : answers[k]!; };
  return { ask: { plain: answer, hidden: answer }, asked };
}
const users = { host: "boxs.ca", calendarUser: "cal-hq-editor@example.test", releaseUser: "editor@example.test" };

describe("approveLoad", () => {
  it("refuses without a terminal, before asking anything", async () => {
    const { ask, asked } = asker({ Type: "load boxs.ca" });
    await expect(approveLoad({ isTTY: false, ask, ...users })).rejects.toThrow(NOT_AT_A_TERMINAL);
    expect(asked).toEqual([]);
  });

  it("asks for no password when the phrase is wrong", async () => {
    const { ask, asked } = asker({ Type: "load boxs" });
    expect(await approveLoad({ isTTY: true, ask, ...users })).toBeNull();
    expect(asked).toHaveLength(1);
  });

  it("collects every password the load needs as soon as it is approved", async () => {
    const { ask, asked } = asker({ Type: "load boxs.ca", "Break-glass admin user": "admin", "Break-glass admin password": "pw-admin", "Password for cal-hq": "pw-cal", "Password for editor": "pw-rel" });
    expect(await approveLoad({ isTTY: true, ask, ...users })).toEqual({ adminUser: "admin", adminPassword: "pw-admin", calendarPassword: "pw-cal", releasePassword: "pw-rel" });
    expect(asked).toHaveLength(5);
  });

  it("stops on an empty password", async () => {
    const { ask } = asker({ Type: "load boxs.ca", "Break-glass admin user": "admin", "Break-glass admin password": "pw-admin", "Password for cal-hq": "pw-cal" });
    await expect(approveLoad({ isTTY: true, ask, ...users })).rejects.toThrow("no password for editor@example.test was given: nothing on boxs.ca changed");
  });
});

describe("checkSecrets", () => {
  const secrets = { adminUser: "admin", adminPassword: "pw-admin", calendarPassword: "pw-cal", releasePassword: "pw-rel" };
  const fake = (wrong: string): typeof fetch => (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { username: string; password: string };
    if (body.password === wrong) return new Response("{}", { status: 401 });
    if (String(input).endsWith("/nrms/auth/local/token")) return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
    return new Response("{}", { status: 200, headers: { "set-cookie": "gcpe_session=s; Path=/" } });
  }) as typeof fetch;

  it("passes when every sign-in works", async () => {
    await expect(checkSecrets("https://boxs.example", users, secrets, fake("none"))).resolves.toBeUndefined();
  });

  it.each([["pw-admin", "the break-glass sign-in failed (HTTP 401)"], ["pw-rel", "signing in as editor@example.test failed: nothing on boxs.example changed"]])("names the sign-in that failed (%s)", async (wrong, message) => {
    await expect(checkSecrets("https://boxs.example", users, secrets, fake(wrong))).rejects.toThrow(message);
  });
});

function restoreDeps(over: Partial<RestoreDeps> = {}): { d: RestoreDeps; calls: string[] } {
  const calls: string[] = [];
  const d: RestoreDeps = {
    isTTY: true,
    ask: async (l) => { calls.push(`ask:${l.split(" ")[0]}`); return l.startsWith("Type") ? "restore 20261022-120000" : ""; },
    backupReady: async () => { calls.push("check"); return true; },
    stopped: async () => { calls.push("stopped"); return true; },
    restore: async () => { calls.push("restore"); },
    started: async () => { calls.push("started"); return true; },
    log: () => {},
    ...over,
  };
  return { d, calls };
}
const target = { stamp: "20261022-120000", host: "boxs.ca" };

describe("runRestore", () => {
  it("checks the backup, confirms, then restores between the stop and the start", async () => {
    const { d, calls } = restoreDeps();
    await runRestore(target, d);
    expect(calls).toEqual(["check", "ask:Type", "ask:Stop", "stopped", "restore", "ask:Start", "started"]);
  });

  it("refuses without a terminal, before anything", async () => {
    const { d, calls } = restoreDeps({ isTTY: false });
    await expect(runRestore(target, d)).rejects.toThrow(NOT_AT_A_TERMINAL);
    expect(calls).toEqual([]);
  });

  it("finds a missing backup before the operator is asked to stop the app", async () => {
    const { d, calls } = restoreDeps({ backupReady: async () => { calls.push("check"); return false; } });
    await expect(runRestore(target, d)).rejects.toThrow("backup 20261022-120000 isn't on boxs.ca or is incomplete: nothing changed");
    expect(calls).toEqual(["check"]);
  });

  it("asks for the app to be started again when the restore fails after the stop", async () => {
    const { d } = restoreDeps({ restore: async () => { throw new ScrubStepError("a step on boxs failed (exit 1)"); } });
    await expect(runRestore(target, d)).rejects.toThrow("a step on boxs failed (exit 1): start the app again in Site Tools");
  });

  it("asks for the app to be started again when the input ends after the stop", async () => {
    const { d } = restoreDeps({ ask: async (l) => { if (l.startsWith("Start")) throw new PromptEndedError(l); return l.startsWith("Type") ? "restore 20261022-120000" : ""; } });
    await expect(runRestore(target, d)).rejects.toThrow(/start the app again in Site Tools$/);
  });
});

describe("backupCheckScript", () => {
  it("looks for every dump and the site-output archive, and changes nothing", () => {
    const s = backupCheckScript("20261022-120000");
    expect(s).toContain('DIR="$HOME/gcpe-data/backups/20261022-120000"');
    for (const f of ["core.sql.gz", "nrms.sql.gz", "news-api.sql.gz", "site.sql.gz", "calendar.sql.gz", "nod.sql.gz", "distribution.sql.gz", "site-output.tar.gz"]) expect(s).toContain(f);
    expect(s.replace(/[\w-]+\.(sql|tar)\.gz/g, "")).not.toMatch(/\b(rm|mv|psql|tar|mkdir|cat|gunzip)\b/);
    expect(() => backupCheckScript("latest")).toThrow(/stamp/);
  });
});

describe("parseRestoreArgs", () => {
  it("takes a stamp and optional host and site", () => {
    expect(parseRestoreArgs(["20261022-120000"])).toEqual({ stamp: "20261022-120000", sshHost: "boxs", site: "https://boxs.ca" });
    expect(() => parseRestoreArgs([])).toThrow(/stamp/);
    expect(() => parseRestoreArgs(["latest"])).toThrow(/stamp/);
  });
});
