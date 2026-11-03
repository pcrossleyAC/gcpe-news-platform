import sql from "mssql";
import { shiftDateText, weekOffset } from "./dates";
import { activityScopeSql, BLOB_CLEANUP_SQL, EMPTIED_SCHEMAS, EMPTIED_TABLES, quoteCol, quoteName, releaseScopeSql, REQUIRED_TABLES } from "./legacy-schema";
import { ScrubArgumentError, ScrubStepError } from "./private-out";

export interface MssqlConfig { server: string; port: number; user: string; password: string; trustServerCertificate: boolean }

export function mssqlConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MssqlConfig {
  const need = (k: string) => { const v = env[k]; if (!v) throw new ScrubArgumentError(`${k} is not set`); return v; };
  return { server: need("LEGACY_SQL_SERVER"), port: Number(env.LEGACY_SQL_PORT ?? 1433), user: need("LEGACY_SQL_USER"), password: need("LEGACY_SQL_PASSWORD"), trustServerCertificate: env.LEGACY_SQL_TRUST_CERT === "true" };
}

export async function openPool(cfg: MssqlConfig, database: string): Promise<sql.ConnectionPool> {
  return new sql.ConnectionPool({
    server: cfg.server, port: cfg.port, user: cfg.user, password: cfg.password, database,
    options: { encrypt: true, trustServerCertificate: cfg.trustServerCertificate },
    requestTimeout: 3_600_000,
    pool: { max: 2 },
  }).connect();
}

export const SCRUB_DB = /^[A-Za-z0-9_.]+_Scrubbed$/;

export async function assertScrubCopy(db: sql.ConnectionPool | sql.Transaction): Promise<void> {
  const request = db instanceof sql.Transaction ? new sql.Request(db) : new sql.Request(db);
  const r = await request.query<{ n: string }>("SELECT DB_NAME() AS n");
  if (!SCRUB_DB.test(r.recordset[0]?.n ?? "")) throw new ScrubStepError("refusing to write: the connection is not to a *_Scrubbed database");
}

export interface BackupFile { LogicalName: string; Type: string }

export function restorePlan(dbName: string, files: BackupFile[], dataDir: string, logDir: string): { sql: string; params: Record<string, string> } {
  if (!SCRUB_DB.test(dbName)) throw new ScrubArgumentError("the scrubbed copy's name must end in _Scrubbed");
  const params: Record<string, string> = { db: dbName };
  let data = 0;
  const moves = files.map((f, i) => {
    const log = f.Type === "L";
    params[`l${i}`] = f.LogicalName;
    params[`f${i}`] = `${(log ? logDir : dataDir).replace(/\/+$/, "")}/${dbName}_${i}.${log ? "ldf" : data++ === 0 ? "mdf" : "ndf"}`;
    return `MOVE @l${i} TO @f${i}`;
  });
  return { sql: `RESTORE DATABASE @db FROM DISK = @backup WITH ${moves.join(", ")}, REPLACE, RECOVERY, STATS = 10;`, params };
}

/** Restores the backup under the scrubbed name. The original database is never opened. */
export async function restoreScrubCopy(master: sql.ConnectionPool, backupPath: string, dbName: string): Promise<void> {
  const files = (await master.request().input("backup", sql.NVarChar, backupPath).query<BackupFile>("RESTORE FILELISTONLY FROM DISK = @backup")).recordset;
  const dirs = (await master.request().query<{ d: string; l: string }>("SELECT CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(400)) AS d, CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS nvarchar(400)) AS l")).recordset[0]!;
  const plan = restorePlan(dbName, files, dirs.d, dirs.l);
  await master.request().input("db", sql.NVarChar, dbName).query("IF DB_ID(@db) IS NOT NULL BEGIN DECLARE @q nvarchar(400) = QUOTENAME(@db); EXEC('ALTER DATABASE ' + @q + ' SET SINGLE_USER WITH ROLLBACK IMMEDIATE'); EXEC('DROP DATABASE ' + @q); END");
  const restore = master.request().input("backup", sql.NVarChar, backupPath);
  for (const [k, v] of Object.entries(plan.params)) restore.input(k, sql.NVarChar, v);
  await restore.query(plan.sql);
  await master.request().input("db", sql.NVarChar, dbName).query("DECLARE @q nvarchar(400) = QUOTENAME(@db); EXEC('ALTER DATABASE ' + @q + ' SET RECOVERY SIMPLE');");
}

export async function tableCounts(pool: sql.ConnectionPool): Promise<Record<string, number>> {
  const rows = (await pool.request().query<{ t: string; n: number }>("SELECT s.name + '.' + t.name AS t, CAST(SUM(p.rows) AS int) AS n FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1) GROUP BY s.name, t.name")).recordset;
  return Object.fromEntries(rows.map((r) => [r.t, r.n]));
}

export async function assertRequiredTables(pool: sql.ConnectionPool): Promise<void> {
  const have = new Set(Object.keys(await tableCounts(pool)));
  const missing = REQUIRED_TABLES.filter((t) => !have.has(t));
  if (missing.length) throw new ScrubStepError(`the backup lacks tables the scrub needs: ${missing.join(", ")}`);
}

async function inTransaction(pool: sql.ConnectionPool, fn: (tx: sql.Transaction) => Promise<void>): Promise<void> {
  await assertScrubCopy(pool);
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await fn(tx);
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

export async function applyScope(pool: sql.ConnectionPool, refUtc: Date, refWall: Date): Promise<void> {
  await inTransaction(pool, async (tx) => {
    await new sql.Request(tx).input("refUtc", sql.DateTimeOffset, refUtc).query(releaseScopeSql());
    await new sql.Request(tx).input("refWall", sql.DateTime, refWall).query(activityScopeSql());
  });
}

export async function emptyTables(pool: sql.ConnectionPool): Promise<string[]> {
  const extra = (await pool.request().query<{ t: string }>(`SELECT s.name + '.' + t.name AS t FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE s.name IN (${EMPTIED_SCHEMAS.map((s) => `'${s}'`).join(", ")})`)).recordset.map((r) => r.t);
  const tables = [...new Set<string>([...EMPTIED_TABLES, ...extra])].sort();
  await inTransaction(pool, async (tx) => {
    // Each table's own foreign keys are switched off so emptied tables can go in any order.
    for (const t of tables) await new sql.Request(tx).query(`ALTER TABLE ${quoteName(t)} NOCHECK CONSTRAINT ALL`);
    for (const t of tables) await new sql.Request(tx).query(`DELETE FROM ${quoteName(t)}`);
    await new sql.Request(tx).query(BLOB_CLEANUP_SQL);
  });
  return tables;
}

export interface DateShiftResult { weeks: number; latestEnd: Date | null; columns: number; logText: { shifted: number; unparsed: number }; clamped: number }

/** Stamp columns, not event columns: the shift can run them past the reference "now" (a row touched
 * this week, shifted forward, lands after the run), which a fictional run time can never truthfully be. */
const STAMP_COLUMNS = new Set(["CreatedDateTime", "LastUpdatedDateTime"]);

export async function shiftCalendarDates(pool: sql.ConnectionPool, refWall: Date, leadDays: number): Promise<DateShiftResult> {
  const latestEnd = (await pool.request().query<{ d: Date | null }>("SELECT MAX(EndDateTime) AS d FROM calendar.Activity")).recordset[0]?.d ?? null;
  const weeks = latestEnd ? weekOffset(latestEnd, refWall, leadDays) : 0;
  const cols = (await pool.request().query<{ t: string; c: string }>("SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'calendar' AND DATA_TYPE IN ('datetime', 'datetime2', 'smalldatetime', 'date', 'datetimeoffset') ORDER BY TABLE_NAME, ORDINAL_POSITION")).recordset;
  const byTable = new Map<string, string[]>();
  for (const r of cols) byTable.set(r.t, [...(byTable.get(r.t) ?? []), r.c]);
  const logText = { shifted: 0, unparsed: 0 };
  let clamped = 0;
  if (weeks > 0) {
    await inTransaction(pool, async (tx) => {
      for (const [t, cs] of byTable) await new sql.Request(tx).input("w", sql.Int, weeks).query(`UPDATE ${quoteName(`calendar.${t}`)} SET ${cs.map((c) => `${quoteCol(c)} = DATEADD(week, @w, ${quoteCol(c)})`).join(", ")}`);
      // Clamp stamp columns the shift pushed past the reference time, after every table has been shifted.
      // Event columns (StartDateTime, EndDateTime, NRDateTime, ...) are left exactly where the shift put them.
      for (const [t, cs] of byTable) {
        for (const c of cs) {
          if (!STAMP_COLUMNS.has(c)) continue;
          const r = await new sql.Request(tx).input("ref", sql.DateTime, refWall).query(`UPDATE ${quoteName(`calendar.${t}`)} SET ${quoteCol(c)} = @ref WHERE ${quoteCol(c)} > @ref`);
          clamped += r.rowsAffected[0] ?? 0;
        }
      }
      const logs = (await new sql.Request(tx).query<{ Id: number; OldValue: string | null; NewValue: string | null }>("SELECT Id, OldValue, NewValue FROM calendar.Log WHERE FieldName IN (N'StartDateTime', N'EndDateTime')")).recordset;
      for (const l of logs) {
        const move = (v: string | null) => {
          if (v === null || v.trim() === "") return v;
          const s = shiftDateText(v, weeks);
          if (s === null) logText.unparsed++;
          return s ?? v;
        };
        const o = move(l.OldValue), n = move(l.NewValue);
        if (o === l.OldValue && n === l.NewValue) continue;
        await new sql.Request(tx).input("id", sql.Int, l.Id).input("o", sql.NVarChar(1000), o).input("n", sql.NVarChar(1000), n).query("UPDATE calendar.Log SET OldValue = @o, NewValue = @n WHERE Id = @id");
        logText.shifted++;
      }
    });
  }
  return { weeks, latestEnd, columns: cols.length, logText, clamped };
}
