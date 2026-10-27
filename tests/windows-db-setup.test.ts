// scripts/windows-db-setup.ts against a real PostgreSQL (TEST_DATABASE_ADMIN_URL, as every other
// database test): the login and seven databases the Windows installer creates, a re-run, and the
// app login actually connecting to its database as the stack will.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { DATABASE_NAMES, dbSetupInputSchema, setupDatabases } from "../scripts/windows-db-setup";

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://localhost:5432/postgres";
const suffix = randomBytes(4).toString("hex");
const input = { user: `win_app_${suffix}`, password: randomBytes(16).toString("hex"), prefix: `win_${suffix}` };

async function asAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

afterAll(async () => {
  await asAdmin(async (c) => {
    for (const name of DATABASE_NAMES) await c.query(`DROP DATABASE IF EXISTS ${c.escapeIdentifier(`${input.prefix}_${name}`)} WITH (FORCE)`);
    await c.query(`DROP ROLE IF EXISTS ${c.escapeIdentifier(input.user)}`);
  });
});

describe("setupDatabases", () => {
  it("creates the login and all seven databases, owned by it, then leaves them alone on a re-run", async () => {
    const first = await setupDatabases(adminUrl, input);
    expect(first.role).toBe("created");
    expect(first.created).toEqual(DATABASE_NAMES.map((n) => `${input.prefix}_${n}`));
    expect(first.existing).toEqual([]);

    const owners = await asAdmin((c) =>
      c.query<{ datname: string; owner: string }>("SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname LIKE $1 ORDER BY datname", [`${input.prefix}_%`]),
    );
    expect(owners.rows.every((r) => r.owner === input.user)).toBe(true);

    const rotated = { ...input, password: randomBytes(16).toString("hex") };
    const second = await setupDatabases(adminUrl, rotated);
    expect(second.role).toBe("updated");
    expect(second.created).toEqual([]);
    expect(second.existing).toHaveLength(DATABASE_NAMES.length);

    // The stack connects as the app login, with the password from the latest run, and can create tables.
    const url = new URL(adminUrl);
    url.username = rotated.user;
    url.password = rotated.password;
    url.pathname = `/${input.prefix}_core`;
    const app = new pg.Client({ connectionString: url.toString() });
    await app.connect();
    try {
      await app.query("CREATE TABLE probe (id int)");
    } finally {
      await app.end();
    }
  });

  it("enables pgvector in the News API database exactly when the server has it", async () => {
    const available = await asAdmin(async (c) => (await c.query("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'")).rowCount === 1);
    const result = await setupDatabases(adminUrl, input);
    expect(result.pgvector).toBe(available);
  });

  it("refuses a short password and an unsafe name before touching the server", () => {
    expect(dbSetupInputSchema.safeParse({ ...input, password: "short" }).success).toBe(false);
    expect(dbSetupInputSchema.safeParse({ ...input, user: 'x"; DROP' }).success).toBe(false);
  });
});
