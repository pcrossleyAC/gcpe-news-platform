import sql from "mssql";
import { IDENTIFIER_COLUMNS, PEOPLE_QUERIES, quoteCol, quoteName, STRUCTURED } from "./legacy-schema";
import { assertScrubCopy } from "./mssql";
import { ScrubStepError } from "./private-out";
import { cleanName, isPlaceholderOrTitle, normEmail, parseName, type PeopleIndex, type Person, type PersonSource } from "./people";
import { entityText, findLeaks, scrubText, type LeakKind, type ScrubCtx } from "./text";

interface PeopleRow { Id: string; Name1: string | null; Name2: string | null; Email: string | null; Phone1: string | null; Phone2: string | null; LinkId: string | null }

export async function readPeopleSources(pool: sql.ConnectionPool): Promise<PersonSource[]> {
  const out: PersonSource[] = [];
  for (const pq of PEOPLE_QUERIES) {
    for (const r of (await pool.request().query<PeopleRow>(pq.sql)).recordset) {
      out.push({ source: pq.source, id: r.Id, names: [r.Name1, r.Name2], email: r.Email, phones: [r.Phone1, r.Phone2], linkId: r.LinkId, ...(pq.linkSource ? { linkSource: pq.linkSource } : {}), ...(pq.alwaysPerson ? { alwaysPerson: true } : {}) });
    }
  }
  return out;
}

function structuredValue(kind: "full" | "email" | "phone" | "username", p: Person, original: string | null): string | null {
  if (original === null || original.trim() === "") return original;
  if (kind === "full") return p.fake.full;
  if (kind === "phone") return p.fake.phone;
  if (kind === "username") return p.fake.username;
  // An unreadable address stays unreadable, so the importers meet the same edge case.
  return normEmail(original) ? p.fake.email : `invalid-${p.fake.slot}`;
}

/** The nth copy of a value in a unique column: a suffix before an address's @, after anything else. */
function nthCopy(kind: "full" | "email" | "phone" | "username", v: string, n: number): string {
  if (n === 1) return v;
  const at = v.indexOf("@");
  return kind === "email" && at > 0 ? `${v.slice(0, at)}-${n}${v.slice(at)}` : `${v} ${n}`;
}

/** A value that fits its column without leaving a cut address or number behind: shorter forms first, then a plain cut. */
function fitStructured(kind: "full" | "email" | "phone" | "username", v: string, p: Person, max: number): string {
  if (max <= 0 || v.length <= max) return v;
  const shorter = kind === "email" && v.endsWith("@example.test") ? [`${p.fake.username}@example.test`, `invalid-${p.fake.slot}`] : kind === "phone" ? [p.fake.phone.slice(4)] : [];
  return shorter.find((s) => s.length <= max) ?? v.slice(0, max).trimEnd();
}

async function rollback(tx: sql.Transaction): Promise<void> {
  // The error that caused the rollback is the one worth reporting.
  try { await tx.rollback(); } catch { /* already rolled back or the connection is gone */ }
}

export async function writeStructuredPeople(pool: sql.ConnectionPool, index: PeopleIndex): Promise<number> {
  await assertScrubCopy(pool);
  const tx = new sql.Transaction(pool);
  await tx.begin();
  let updated = 0;
  try {
    for (const spec of STRUCTURED) {
      const cols = Object.keys(spec.columns);
      const [schema, table] = spec.table.split(".");
      const meta = await new sql.Request(tx).input("s", schema).input("t", table).query<{ c: string; m: number | null; u: number }>(
        "SELECT c.name AS c, CASE WHEN c.max_length = -1 THEN NULL WHEN ty.name IN ('nchar', 'nvarchar') THEN c.max_length / 2 ELSE c.max_length END AS m, CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id WHERE ic.object_id = c.object_id AND ic.column_id = c.column_id AND i.is_unique = 1 AND (SELECT COUNT(*) FROM sys.index_columns k WHERE k.object_id = i.object_id AND k.index_id = i.index_id AND k.is_included_column = 0) = 1) THEN 1 ELSE 0 END AS u FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id WHERE c.object_id = OBJECT_ID(QUOTENAME(@s) + '.' + QUOTENAME(@t))",
      );
      const width = new Map(meta.recordset.map((r) => [r.c, r.m ?? -1]));
      const unique = new Set(meta.recordset.filter((r) => r.u === 1).map((r) => r.c));
      const taken = new Map(cols.map((c) => [c, new Set<string>()]));
      const rows = (await new sql.Request(tx).query<Record<string, string | null> & { Id: string }>(`SELECT CAST(Id AS nvarchar(50)) AS Id, ${cols.map(quoteCol).join(", ")} FROM ${quoteName(spec.table)} ORDER BY Id`)).recordset;
      for (const row of rows) {
        const p = index.bySource.get(`${spec.source}:${row.Id}`);
        if (!p) continue;
        const req = new sql.Request(tx).input("id", sql.NVarChar(50), row.Id);
        cols.forEach((c, i) => {
          const kind = spec.columns[c]!;
          const base = structuredValue(kind, p, row[c] ?? null);
          let v = base;
          if (base !== null && base.trim() !== "") {
            // Two rows of one person in a unique column (dbo.User's display name and address) each get their own copy.
            const seen = taken.get(c)!;
            for (let n = 1; ; n++) {
              v = fitStructured(kind, nthCopy(kind, base, n), p, width.get(c) ?? -1);
              if (!unique.has(c) || !seen.has(v.toLowerCase())) break;
              if (n > 1000) throw new ScrubStepError(`${spec.table}.${c}: no unique fictional value fits the column`);
            }
            seen.add(v!.toLowerCase());
          }
          req.input(`v${i}`, sql.NVarChar(sql.MAX), v);
        });
        const r = await req.query(`UPDATE ${quoteName(spec.table)} SET ${cols.map((c, i) => `${quoteCol(c)} = @v${i}`).join(", ")} WHERE Id = @id`);
        if (r.rowsAffected[0] !== 1) throw new ScrubStepError(`${spec.table}: a people row was not matched by its id`);
        updated++;
      }
    }
    await tx.commit();
  } catch (e) {
    await rollback(tx);
    throw e;
  }
  return updated;
}

export interface TextTable { table: string; pk: string[]; columns: { name: string; max: number }[] }

export async function textTables(pool: sql.ConnectionPool): Promise<TextTable[]> {
  const cols = (await pool.request().query<{ t: string; c: string; m: number | null }>("SELECT c.TABLE_SCHEMA + '.' + c.TABLE_NAME AS t, c.COLUMN_NAME AS c, c.CHARACTER_MAXIMUM_LENGTH AS m FROM INFORMATION_SCHEMA.COLUMNS c JOIN INFORMATION_SCHEMA.TABLES tb ON tb.TABLE_SCHEMA = c.TABLE_SCHEMA AND tb.TABLE_NAME = c.TABLE_NAME AND tb.TABLE_TYPE = 'BASE TABLE' WHERE c.DATA_TYPE IN ('char', 'nchar', 'varchar', 'nvarchar', 'text', 'ntext') ORDER BY 1, c.ORDINAL_POSITION")).recordset;
  const pks = (await pool.request().query<{ t: string; c: string }>("SELECT s.name + '.' + t.name AS t, c.name AS c FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id JOIN sys.tables t ON t.object_id = i.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE i.is_primary_key = 1 ORDER BY 1, ic.key_ordinal")).recordset;
  const pkOf = new Map<string, string[]>();
  for (const r of pks) pkOf.set(r.t, [...(pkOf.get(r.t) ?? []), r.c]);
  const out = new Map<string, TextTable>();
  for (const r of cols) {
    const t = out.get(r.t) ?? { table: r.t, pk: pkOf.get(r.t) ?? [], columns: [] };
    t.columns.push({ name: r.c, max: r.m ?? -1 });
    out.set(r.t, t);
  }
  return [...out.values()];
}

async function forEachPage(db: sql.ConnectionPool | sql.Transaction, t: TextTable, cols: string[], fn: (rows: Record<string, unknown>[]) => Promise<void>, pageSize = 2000): Promise<void> {
  const select = [...new Set([...t.pk, ...cols])].map(quoteCol).join(", ");
  if (t.pk.length === 0) throw new ScrubStepError(`${t.table} has text columns but no primary key`);
  const order = t.pk.map(quoteCol).join(", ");
  for (let offset = 0; ; offset += pageSize) {
    const req = db instanceof sql.Transaction ? new sql.Request(db) : new sql.Request(db);
    const rows = (await req.input("o", sql.Int, offset).input("n", sql.Int, pageSize).query<Record<string, unknown>>(`SELECT ${select} FROM ${quoteName(t.table)} ORDER BY ${order} OFFSET @o ROWS FETCH NEXT @n ROWS ONLY`)).recordset;
    if (rows.length > 0) await fn(rows);
    if (rows.length < pageSize) return;
  }
}

/**
 * Scrubbed text cut to its column. A cut inside a word drops the whole word, so no address or number is left half
 * written ("…@example.te" still reads as an address); what remains must be text a second scrub would leave alone.
 */
export function fitText(text: string, max: number, ctx: ScrubCtx, where = "a column"): string {
  let next = text.slice(0, max);
  if (!/\s/.test(text[max] ?? " ")) next = next.replace(/\S+$/, "");
  if (scrubText(next, ctx).text !== next) throw new ScrubStepError(`${where}: text cut to the column would change on a second scrub`);
  return next;
}

export interface TableScrub { rows: number; changed: number; truncated: number; names: number; emails: number; phones: number }

export async function scrubAllText(pool: sql.ConnectionPool, ctx: ScrubCtx, log: (line: string) => void = () => {}): Promise<Record<string, TableScrub>> {
  await assertScrubCopy(pool);
  const report: Record<string, TableScrub> = {};
  for (const t of await textTables(pool)) {
    const cols = t.columns.filter((c) => !t.pk.includes(c.name) && !(IDENTIFIER_COLUMNS[t.table] ?? []).includes(c.name));
    if (cols.length === 0) continue;
    if (t.pk.length === 0) throw new ScrubStepError(`${t.table} has text columns but no primary key`);
    const r: TableScrub = { rows: 0, changed: 0, truncated: 0, names: 0, emails: 0, phones: 0 };
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      await forEachPage(tx, t, cols.map((c) => c.name), async (rows) => {
        for (const row of rows) {
          r.rows++;
          const set: [string, string][] = [];
          for (const c of cols) {
            const v = row[c.name];
            if (typeof v !== "string" || v === "") continue;
            const s = scrubText(v, ctx);
            r.names += s.counts.names; r.emails += s.counts.emails; r.phones += s.counts.phones;
            let next = s.text;
            if (c.max > 0 && next.length > c.max) { next = fitText(next, c.max, ctx, `${t.table}.${c.name}`); r.truncated++; }
            if (next !== v) set.push([c.name, next]);
          }
          if (set.length === 0) continue;
          const req = new sql.Request(tx);
          set.forEach(([, v], i) => req.input(`v${i}`, sql.NVarChar(sql.MAX), v));
          t.pk.forEach((k, i) => req.input(`k${i}`, row[k]));
          const done = await req.query(`UPDATE ${quoteName(t.table)} SET ${set.map(([c], i) => `${quoteCol(c)} = @v${i}`).join(", ")} WHERE ${t.pk.map((k, i) => `${quoteCol(k)} = @k${i}`).join(" AND ")}`);
          if (done.rowsAffected[0] !== 1) throw new ScrubStepError(`${t.table}: a row was not matched by its key`);
          r.changed++;
        }
      });
      await tx.commit();
    } catch (e) {
      await rollback(tx);
      throw e;
    }
    report[t.table] = r;
    log(`${t.table}: ${r.rows} rows read, ${r.changed} changed, ${r.truncated} fitted to their column`);
  }
  return report;
}

export type LiteralKind = "literal-name" | "literal-email" | "literal-phone";
export type GateKind = LeakKind | LiteralKind;

/** Sources whose people hold public office (MLAs, ministers): their names may stay in text, their contacts may not. */
export const PUBLIC_OFFICE_SOURCES = ["calendar.GovernmentRepresentative", "dbo.Ministry"] as const;
const isPublicOffice = (p: Person) => p.sources.some((s) => PUBLIC_OFFICE_SOURCES.some((src) => s.startsWith(`${src}:`)));
const isPublicOfficeSource = (s: PersonSource) => (PUBLIC_OFFICE_SOURCES as readonly string[]).includes(s.source);

const ENTITY_RE = /&(?:[a-z][a-z0-9]*|#\d+|#x[0-9a-f]+);/gi;
const TAG_RE = /<[^<>]{0,200}>/g;
const WORD_RE = /[\p{L}\p{N}]+/gu;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const LOOSE_EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g;
/** Digit groups a phone may be written in: "604 555 0142", "(604)555-0142", "+1.604.555.0142", "604 — 555 — 0142" (en dashes are folded to "-"). */
const DIGIT_RUN_RE = /\d+(?:[ ().\-+/\u2014\u2212]{1,3}\d+)*/g;
/** What the scrubber itself writes; a real number in that range can't be told from a fictional one. */
const FAKE_DIGITS = /^(?:250)?55501\d\d$/;

/** Text as the literal route compares it: entities decoded, accents and case folded, whitespace collapsed, commas spaced one way. */
export function literalFold(s: string): string {
  return s.replace(ENTITY_RE, (e) => entityText(e) ?? " ").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[\u200b\ufeff]/g, " ").replace(/[‘’]/g, "'").replace(/[‐-–]/g, "-").replace(/\s+/g, " ").replace(/ ?, ?/g, ", ").trim();
}

/** The digits a stored phone is found by: ten without a leading 1, or a seven-digit local number. */
function phoneDigits(raw: string): string | null {
  let d = raw.replace(/\D/g, "");
  if (d.length >= 11 && d[0] === "1") d = d.slice(1);
  if (d.length >= 10) d = d.slice(0, 10);
  else if (d.length !== 7) return null;
  return FAKE_DIGITS.test(d) ? null : d;
}

/** Real names, emails and phones keyed for the literal route; each value says whether every owner holds public office. */
export interface LiteralNeedles { names: Map<string, Map<string, boolean>>; emails: Map<string, boolean>; phones: Map<string, boolean> }

export function buildLiteralNeedles(index: PeopleIndex): LiteralNeedles {
  const n: LiteralNeedles = { names: new Map(), emails: new Map(), phones: new Map() };
  const put = (m: Map<string, boolean>, k: string, pub: boolean) => m.set(k, (m.get(k) ?? true) && pub);
  // Every form the name routes match by, fallbacks included, is also searched for literally.
  const variantsOf = new Map<Person, string[]>();
  for (const [key, hit] of index.byVariant) variantsOf.set(hit.person, [...(variantsOf.get(hit.person) ?? []), key]);
  const add = (names: Iterable<string>, emails: Iterable<string>, phones: Iterable<string>, pub: boolean, variants: string[] = []) => {
    const forms = new Set<string>(variants);
    for (const raw of names) {
      // An office, role or placeholder ("Media Relations", "News Staff") is ordinary words, not a name to search for.
      if (isPlaceholderOrTitle(raw)) continue;
      // The name without a bracketed note, address or trailing number: "News 1130" is searched for as "News", which is no needle.
      forms.add(cleanName(raw));
      const parsed = parseName(raw);
      if (parsed) {
        const given = parsed.given.join(" "), first = parsed.given[0]!, last = parsed.surname.join(" ");
        for (const f of [`${given} ${last}`, `${first} ${last}`, `${last}, ${given}`, `${last}, ${first}`]) forms.add(f);
      }
    }
    for (const f of forms) {
      const words = [...literalFold(f).matchAll(WORD_RE)];
      // A bare word, a surname alone, would match ordinary text; so would anything shorter than four characters.
      if (words.length < 2) continue;
      const first = words[0]!, last = words[words.length - 1]!;
      const needle = literalFold(f).slice(first.index, last.index + last[0].length);
      if (needle.length < 4) continue;
      const byFirst = n.names.get(first[0]) ?? new Map<string, boolean>();
      put(byFirst, needle, pub);
      n.names.set(first[0], byFirst);
    }
    // Contacts fail the gate for everyone, office holders included.
    for (const e of emails) if (e.length >= 4) put(n.emails, literalFold(e), false);
    for (const ph of phones) { const d = phoneDigits(ph); if (d) put(n.phones, d, false); }
  };
  for (const p of index.persons) add(p.names, p.emails, p.phones, isPublicOffice(p), variantsOf.get(p));
  // A row that joined no person (an unreadable name with no email) is still searched for by what it stores.
  for (const r of index.strays) {
    const email = normEmail(r.email);
    add(r.names.filter((x): x is string => !!x && x.trim() !== ""), email ? [email] : [], r.phones.filter((x): x is string => !!x), isPublicOfficeSource(r));
  }
  return n;
}

/** A lone letter that may sit inside a name ("quill b. ashbury"); "a" and "i" only with a period, since alone they are words. */
const INITIAL_GAP = /^ (?:[^\P{L}ai]\.?|[ai]\.) /u;

/**
 * The length of a needle found at `at` in the folded text, or 0. As in the name routes, one middle initial the needle
 * doesn't hold may be skipped between two of its words, but not beside a comma.
 */
function needleAt(text: string, at: number, needle: string): number {
  const whole = (end: number) => !WORD_CHAR.test(text[end] ?? "");
  if (text.startsWith(needle, at) && whole(at + needle.length)) return needle.length;
  for (let k = needle.indexOf(" "); k > 0; k = needle.indexOf(" ", k + 1)) {
    if (needle[k - 1] === "," || !text.startsWith(needle.slice(0, k), at)) continue;
    const gap = INITIAL_GAP.exec(text.slice(at + k, at + k + 4));
    if (!gap) continue;
    const tail = at + k + gap[0].length;
    const rest = needle.slice(k + 1);
    if (text.startsWith(rest, tail) && whole(tail + rest.length)) return tail + rest.length - at;
  }
  return 0;
}

function nameMentions(text: string, names: LiteralNeedles["names"]): { leaks: number; publicOffice: number } {
  const r = { leaks: 0, publicOffice: 0 };
  let resume = 0;
  for (const m of text.matchAll(WORD_RE)) {
    if (m.index < resume) continue;
    const candidates = names.get(m[0]);
    if (!candidates) continue;
    let best = 0;
    let pub = false;
    for (const [needle, isPub] of candidates) {
      const len = needleAt(text, m.index, needle);
      if (len > best) { best = len; pub = isPub; }
    }
    if (best === 0) continue;
    if (pub) r.publicOffice++; else r.leaks++;
    resume = m.index + best;
  }
  return r;
}

function phoneMentions(text: string, phones: LiteralNeedles["phones"]): number {
  let hits = 0;
  for (const run of text.matchAll(DIGIT_RUN_RE)) {
    const groups = run[0].match(/\d+/g)!;
    for (let i = 0; i < groups.length;) {
      let used = 0;
      for (let j = Math.min(groups.length, i + 4); j > i && used === 0; j--) {
        const d = groups.slice(i, j).join("");
        if (phones.has(d) || (d.length === 11 && d[0] === "1" && phones.has(d.slice(1)))) used = j - i;
      }
      if (used > 0) { hits++; i += used; } else i++;
    }
  }
  return hits;
}

/**
 * Gate 1's literal route: every real full name (as stored, given-first and surname-first where it parses, and every
 * form the name routes match by), email and phone, searched for as whole words in the folded text, with one middle
 * initial allowed. Stored names don't depend on the parser, so a person it can't read is still found; names it reads
 * as offices or placeholders are left out, their contacts are not. Tags are searched both blanked out and in place, so names split by markup and names in
 * attributes are both seen; the larger count stands.
 */
export function literalHits(text: string, needles: LiteralNeedles): { kind: LiteralKind; publicOffice: boolean }[] {
  const kept = literalFold(text);
  const blanked = literalFold(text.replace(TAG_RE, " "));
  const a = nameMentions(kept, needles.names), b = nameMentions(blanked, needles.names);
  const out: { kind: LiteralKind; publicOffice: boolean }[] = [];
  const push = (kind: LiteralKind, publicOffice: boolean, n: number) => { for (let i = 0; i < n; i++) out.push({ kind, publicOffice }); };
  push("literal-name", false, Math.max(a.leaks, b.leaks));
  push("literal-name", true, Math.max(a.publicOffice, b.publicOffice));
  push("literal-email", false, [...kept.matchAll(LOOSE_EMAIL_RE)].filter((m) => needles.emails.has(m[0])).length);
  push("literal-phone", false, phoneMentions(kept, needles.phones));
  return out;
}

export interface GateHit { table: string; column: string; kind: GateKind; count: number }
export interface GateResult {
  hits: GateHit[];
  rows: { table: string; column: string; kind: GateKind; id: string }[];
  /** Literal mentions of public office holders' names: reported, never a failure. */
  publicOffice: GateHit[];
  publicOfficeHits: number;
}

export async function gateMssql(pool: sql.ConnectionPool, index: PeopleIndex, log: (line: string) => void = () => {}): Promise<GateResult> {
  const needles = buildLiteralNeedles(index);
  const counts = new Map<string, GateHit>();
  const office = new Map<string, GateHit>();
  const rows: GateResult["rows"] = [];
  const tally = (m: Map<string, GateHit>, table: string, column: string, kind: GateKind) => {
    const k = `${table}|${column}|${kind}`;
    const h = m.get(k) ?? { table, column, kind, count: 0 };
    h.count++;
    m.set(k, h);
  };
  for (const t of await textTables(pool)) {
    const cols = t.columns.map((c) => c.name);
    let read = 0, leaks = 0, mentions = 0;
    await forEachPage(pool, t, cols, async (page) => {
      for (const row of page) {
        read++;
        for (const c of cols) {
          const v = row[c];
          if (typeof v !== "string" || v === "") continue;
          const kinds: GateKind[] = [...findLeaks(v, index)];
          for (const h of literalHits(v, needles)) {
            if (h.publicOffice) { tally(office, t.table, c, h.kind); mentions++; } else kinds.push(h.kind);
          }
          for (const kind of kinds) {
            tally(counts, t.table, c, kind);
            rows.push({ table: t.table, column: c, kind, id: t.pk.map((p) => String(row[p])).join("/") });
            leaks++;
          }
        }
      }
    });
    log(`${t.table}: ${read} rows checked, ${leaks} leaks, ${mentions} public office mentions`);
  }
  const publicOffice = [...office.values()];
  return { hits: [...counts.values()], rows, publicOffice, publicOfficeHits: publicOffice.reduce((s, h) => s + h.count, 0) };
}
