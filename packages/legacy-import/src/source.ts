import sql from "mssql";

export interface LegacySource {
  query<T extends Record<string, unknown>>(sqlText: string): Promise<T[]>;
  close(): Promise<void>;
}

export async function createMssqlSource(config: {
  server: string;
  database: string;
  user: string;
  password: string;
  port?: number;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
}): Promise<LegacySource> {
  const pool = await new sql.ConnectionPool({
    server: config.server,
    database: config.database,
    user: config.user,
    password: config.password,
    port: config.port ?? 1433,
    options: { encrypt: config.encrypt ?? true, trustServerCertificate: config.trustServerCertificate ?? false },
    requestTimeout: 120_000,
  }).connect();
  return {
    async query<T extends Record<string, unknown>>(sqlText: string): Promise<T[]> {
      const result = await pool.request().query<T>(sqlText);
      return result.recordset as unknown as T[];
    },
    async close() {
      await pool.close();
    },
  };
}

function queryName(sqlText: string): string {
  const first = sqlText.trimStart().split("\n")[0] ?? "";
  const match = /^--\s*name:\s*(\S+)/.exec(first);
  if (!match) throw new Error("Legacy queries must start with a '-- name: <name>' line");
  return match[1]!;
}

export function createFakeSource(tables: Record<string, Record<string, unknown>[]>): LegacySource {
  return {
    async query<T extends Record<string, unknown>>(sqlText: string): Promise<T[]> {
      const name = queryName(sqlText);
      const rows = tables[name];
      if (!rows) throw new Error(`Fake source has no rows for query '${name}'`);
      return rows as T[];
    },
    async close() {},
  };
}
