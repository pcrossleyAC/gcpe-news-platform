import { join, resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { gatePostgres } from "../../scripts/lib/scrub/pg-gate";
import { buildPeopleIndex } from "../../scripts/lib/scrub/people";

const CORE_MIGRATIONS = join(resolve(import.meta.dirname, "..", ".."), "apps", "core", "migrations");

/** A name the parser can't read (six words), so only the literal route knows it. */
const UNPARSED = "Ximena de la Paz Okonkwo Ruiz";
/** A minister listed by honorific and surname only: unparseable, indexed through the email, and a public office source. */
const MINISTER = "Hon. Okonkwo-Bell";

const index = buildPeopleIndex([
  { source: "t", id: "1", names: ["Quill Ashbury"], email: "quill.ashbury@gov.example", phones: [] },
  { source: "t", id: "2", names: [UNPARSED], email: "ximena.ruiz@gov.example", phones: [] },
  { source: "dbo.Ministry", id: "M1", names: [MINISTER], email: "okonkwo-bell@gov.example", phones: [] },
], "f".repeat(64));

describe("gatePostgres", () => {
  let core: TestDatabase;
  beforeAll(async () => { core = await createTestDatabase({ migrationsFolder: CORE_MIGRATIONS }); });
  afterAll(async () => { await core?.drop(); });
  const exec = async (text: string, values: unknown[] = []) => { const c = new pg.Client({ connectionString: core.url }); await c.connect(); try { await c.query(text, values); } finally { await c.end(); } };

  it("passes a clean database", async () => {
    const r = await gatePostgres([{ name: "core", url: core.url }], index, { coreUrl: core.url, signInAllowed: new Set() });
    expect(r).toMatchObject({ hits: [], signInProblems: 0, publicOffice: [], publicOfficeHits: 0 });
  });

  it("finds names in text and inside JSON, and real emails", async () => {
    await exec("INSERT INTO organizations (key, display_name, minister, social) VALUES ('health', 'Health', $1::jsonb, '{}'::jsonb)", [JSON.stringify({ name: "Quill\nAshbury", email: "quill.ashbury@gov.example" })]);
    const r = await gatePostgres([{ name: "core", url: core.url }], index, { coreUrl: core.url, signInAllowed: new Set() });
    expect(r.hits).toEqual(expect.arrayContaining([
      { table: "core.organizations", column: "minister", kind: "name", count: 1 },
      { table: "core.organizations", column: "minister", kind: "email", count: 1 },
    ]));
  });

  it("finds a leak inside a JSON string value and inside an array element", async () => {
    await exec(
      "INSERT INTO organizations (key, display_name, minister, social, contact, sector_keys) VALUES ('agriculture', 'Agriculture', '{}'::jsonb, '{}'::jsonb, $1::jsonb, $2)",
      [JSON.stringify({ note: "Reach Quill Ashbury directly" }), ["agri", "Reach quill.ashbury@gov.example now"]],
    );
    const r = await gatePostgres([{ name: "core", url: core.url }], index, { coreUrl: core.url, signInAllowed: new Set() });
    expect(r.hits).toEqual(expect.arrayContaining([
      { table: "core.organizations", column: "contact", kind: "name", count: 1 },
      { table: "core.organizations", column: "sector_keys", kind: "email", count: 1 },
    ]));
  });

  it("fails Gate 2 through the literal route on a parser-proof person planted in a text column", async () => {
    await exec("INSERT INTO organizations (key, display_name, minister, social, url) VALUES ('culture', 'Culture', '{}'::jsonb, '{}'::jsonb, $1)", [`Contact ${UNPARSED} for details`]);
    const r = await gatePostgres([{ name: "core", url: core.url }], index, { coreUrl: core.url, signInAllowed: new Set() });
    expect(r.hits).toEqual(expect.arrayContaining([{ table: "core.organizations", column: "url", kind: "literal-name", count: 1 }]));
  });

  it("counts a public office holder's name without failing the gate", async () => {
    await exec("INSERT INTO organizations (key, display_name, minister, social, display_additional_name) VALUES ('tourism', 'Tourism', '{}'::jsonb, '{}'::jsonb, $1)", [`${MINISTER} spoke today`]);
    const r = await gatePostgres([{ name: "core", url: core.url }], index, { coreUrl: core.url, signInAllowed: new Set() });
    expect(r.publicOffice).toEqual(expect.arrayContaining([{ table: "core.organizations", column: "display_additional_name", kind: "literal-name", count: 1 }]));
    expect(r.publicOfficeHits).toBeGreaterThanOrEqual(1);
    expect(r.hits.some((h) => h.table === "core.organizations" && h.column === "display_additional_name" && h.kind === "literal-name")).toBe(false);
  });

  it("counts users who could sign in and aren't carried-over test accounts", async () => {
    await exec("INSERT INTO users (email, display_name, password_hash) VALUES ('alex.ashfield@example.test', 'Alex Ashfield', 'scrypt$x'), ('editor@example.test', 'Test Editor', 'scrypt$y')");
    const r = await gatePostgres([], index, { coreUrl: core.url, signInAllowed: new Set(["editor@example.test"]) });
    expect(r.signInProblems).toBe(1);
  });
});
