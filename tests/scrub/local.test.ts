import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { importSteps, legacyEnv, localDbUrl, parseTestAccounts, runStep, seedTestAccounts, signInEmails } from "../../scripts/lib/scrub/local";

const cfg = { server: "127.0.0.1", port: 1433, user: "sa", password: "fictional-password", trustServerCertificate: true };
const urls = { core: "postgres://h/scrub_core", nrms: "postgres://h/scrub_nrms", newsApi: "postgres://h/scrub_news_api", site: "postgres://h/scrub_site", calendar: "postgres://h/scrub_calendar", nod: "postgres://h/scrub_nod", distribution: "postgres://h/scrub_distribution" };

describe("importer steps", () => {
  it("only ever point the importers at the scrubbed copy", () => {
    expect(() => legacyEnv(cfg, "Gcpe.Hub")).toThrow(/_Scrubbed/);
    expect(() => legacyEnv({ ...cfg, port: 1434 }, "Gcpe.Hub_Scrubbed")).toThrow(/1433/);
    const steps = importSteps(urls, legacyEnv(cfg, "Gcpe.Hub_Scrubbed"), { out: "/p/run", cutoff: "2000-01-01" });
    expect(steps.map((s) => s.name)).toEqual(["core", "nrms", "calendar", "news-api"]);
    for (const s of steps) expect(s.env.LEGACY_SQL_DATABASE).toBe("Gcpe.Hub_Scrubbed");
    expect(steps[2]!.npmArgs).toEqual(["run", "calendar:import", "--", "--cutoff", "2000-01-01", "--confirm", "--report", "/p/run/reports/calendar-import.json"]);
    expect(JSON.parse(steps[2]!.env.CORE_EVENT_SUBSCRIBERS!).map((s: { name: string }) => s.name)).toEqual(["calendar", "nrms"]);
    // Only the calendar step queues Core's user.upserted events (for the later trial step's
    // in-process stack to deliver); core, nrms and news-api set no subscribers.
    for (const s of steps) {
      if (s.name === "calendar") continue;
      expect(s.env.EVENT_SUBSCRIBERS).toBeUndefined();
      expect(s.env.CORE_EVENT_SUBSCRIBERS).toBeUndefined();
    }
    expect(steps[1]!.env).toMatchObject({ DATABASE_URL: urls.nrms, CORE_DATABASE_URL: urls.core });
  });

  it("builds local URLs only for scrub_ names", () => {
    expect(localDbUrl("scrub_core", "postgres://localhost:5432/postgres")).toBe("postgres://localhost:5432/scrub_core");
    expect(() => localDbUrl("rehearsal_core")).toThrow();
  });

  it("writes a step's output to its log and returns the exit code", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "scrub-step-")), "x.log");
    const fake = ((_cmd: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      const child = new EventEmitter();
      expect(opts.env.DATABASE_URL).toBe("postgres://h/x");
      setImmediate(() => child.emit("exit", 2));
      return child;
    }) as never;
    expect(await runStep({ name: "x", npmArgs: ["run", "x"], env: { DATABASE_URL: "postgres://h/x" } }, log, fake)).toBe(2);
    expect(readFileSync(log, "utf8")).toBe("");
  });
});

const ACCOUNTS = JSON.stringify({
  users: [{ id: "c0000000-0000-4000-8000-000000000001", email: "editor@example.test", display_name: "Test Editor", is_active: true, sign_in_method: "local", password_hash: "scrypt$fictional", entra_oid: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }],
  roleGrants: [{ user_id: "c0000000-0000-4000-8000-000000000001", role: "NRMS.Editor", granted_at: "2026-10-01T00:00:00Z" }],
  memberships: [{ user_id: "c0000000-0000-4000-8000-000000000001", org_key: "health", org_abbreviation: "HLTH" }],
});

describe("test accounts", () => {
  let core: TestDatabase;
  beforeAll(async () => { core = await createTestDatabase({ migrationsFolder: join(resolve(import.meta.dirname, "..", ".."), "apps", "core", "migrations") }); });
  afterAll(async () => { await core?.drop(); });
  const count = async (table: string) => { const c = new pg.Client({ connectionString: core.url }); await c.connect(); try { return (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n; } finally { await c.end(); } };

  it("parses and lists the accounts that may sign in", () => {
    expect([...signInEmails(parseTestAccounts(ACCOUNTS))]).toEqual(["editor@example.test"]);
    expect(() => parseTestAccounts("{}")).toThrow();
  });

  it("refuses, and writes nothing, when an organisation is missing", async () => {
    await expect(seedTestAccounts(core.url, parseTestAccounts(ACCOUNTS))).rejects.toThrow(/health/);
    expect(await count("users")).toBe(0);
  });

  it("seeds users, grants and memberships by organisation key", async () => {
    const c = new pg.Client({ connectionString: core.url }); await c.connect();
    try { await c.query("INSERT INTO organizations (key, display_name, abbreviation, minister, social) VALUES ('health', 'Health', 'HLTH', '{}'::jsonb, '{}'::jsonb)"); } finally { await c.end(); }
    expect(await seedTestAccounts(core.url, parseTestAccounts(ACCOUNTS))).toEqual({ users: 1, grants: 1, memberships: 1 });
    expect(await count("user_organizations")).toBe(1);
  });
});
