import pg from "pg";
import { buildLiteralNeedles, literalHits, type GateHit, type GateKind, type GateResult } from "./mssql-text";
import { withoutFallbacks, type PeopleIndex } from "./people";
import { findLeaks } from "./text";

export interface PgGateResult extends GateResult { signInProblems: number }

/** Users who could sign in but aren't a carried-over test account, or whose email isn't fictional. */
export const SIGN_IN_SQL = "SELECT count(*)::int AS n FROM users WHERE NOT (lower(coalesce(email, '')) = ANY($1::text[])) AND (password_hash IS NOT NULL OR entra_oid IS NOT NULL OR (email IS NOT NULL AND lower(email) NOT LIKE '%@example.test'))";

const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** An address as the leak routes would see it whole: nothing address-like on either side. */
const ADDRESS_RE = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?![\w-])/g;
/**
 * boxs.ca's own carried-over test accounts keep their addresses, some of them outside example.test. Exactly those
 * addresses are blanked before a value is searched; any other address, and any name or phone, is searched as before.
 */
export function withoutTestAccounts(s: string, allowed: ReadonlySet<string>): string {
  return allowed.size === 0 ? s : s.replace(ADDRESS_RE, (e) => (allowed.has(e.toLowerCase()) ? " " : e));
}
/** Every string a column's value holds: itself, each element of an array, or each string value inside JSON. */
function stringsOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v !== null && typeof v === "object" && !(v instanceof Date) && !Buffer.isBuffer(v)) for (const x of Object.values(v)) stringsOf(x, out);
  return out;
}

export async function gatePostgres(dbs: { name: string; url: string }[], people: PeopleIndex, o: { coreUrl: string; signInAllowed: ReadonlySet<string> }): Promise<PgGateResult> {
  // Gate 2 doesn't count a fallback form alone: the News API's search text joins fields, which can line one up.
  const index = withoutFallbacks(people);
  const needles = buildLiteralNeedles(index);
  const allowed = new Set([...o.signInAllowed].map((e) => e.toLowerCase()));
  const counts = new Map<string, GateHit>();
  const office = new Map<string, GateHit>();
  const rows: GateResult["rows"] = [];
  const tally = (m: Map<string, GateHit>, table: string, column: string, kind: GateKind) => {
    const k = `${table}|${column}|${kind}`;
    const h = m.get(k) ?? { table, column, kind, count: 0 };
    h.count++;
    m.set(k, h);
  };
  for (const db of dbs) {
    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      const cols = (await client.query<{ t: string; c: string }>("SELECT c.table_name AS t, c.column_name AS c FROM information_schema.columns c JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name WHERE c.table_schema = 'public' AND tb.table_type = 'BASE TABLE' AND (c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb') OR (c.data_type = 'ARRAY' AND c.udt_name IN ('_text', '_varchar'))) ORDER BY c.table_name, c.ordinal_position")).rows;
      const byTable = new Map<string, string[]>();
      for (const r of cols) byTable.set(r.t, [...(byTable.get(r.t) ?? []), r.c]);
      for (const [table, columns] of byTable) {
        let after = "(0,0)";
        for (;;) {
          const page = (await client.query<Record<string, unknown> & { ctid: string }>(`SELECT ctid::text AS ctid, ${columns.map(qi).join(", ")} FROM ${qi(table)} WHERE ctid > $1::tid ORDER BY ctid LIMIT 2000`, [after])).rows;
          for (const row of page) for (const c of columns) for (const value of stringsOf(row[c])) {
            const s = withoutTestAccounts(value, allowed);
            const t = `${db.name}.${table}`;
            const kinds: GateKind[] = [...findLeaks(s, index)];
            for (const h of literalHits(s, needles)) {
              if (h.publicOffice) tally(office, t, c, h.kind);
              else kinds.push(h.kind);
            }
            for (const kind of kinds) {
              tally(counts, t, c, kind);
              rows.push({ table: t, column: c, kind, id: row.ctid });
            }
          }
          if (page.length < 2000) break;
          after = page[page.length - 1]!.ctid;
        }
      }
    } finally {
      await client.end();
    }
  }
  const core = new pg.Client({ connectionString: o.coreUrl });
  await core.connect();
  try {
    const signInProblems = (await core.query<{ n: number }>(SIGN_IN_SQL, [[...o.signInAllowed].map((e) => e.toLowerCase())])).rows[0]!.n;
    const publicOffice = [...office.values()];
    return { hits: [...counts.values()], rows, publicOffice, publicOfficeHits: publicOffice.reduce((s, h) => s + h.count, 0), signInProblems };
  } finally {
    await core.end();
  }
}
