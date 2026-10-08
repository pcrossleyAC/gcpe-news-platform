import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import { CALENDAR_LEVELS, type CalendarRole } from "@gcpe/auth";

export const LOOKUP_NAMES = [
  "categories", "cities", "comm-materials", "event-planners", "government-representatives", "initiatives",
  "keywords", "nr-distributions", "nr-origins", "premier-requested", "videographers",
] as const;
export type LookupName = (typeof LOOKUP_NAMES)[number];
export type ExtraKey = "phone" | "jobTitle" | "description" | "shortName";
const EXTRA_COLUMNS: Record<ExtraKey, string> = { phone: "phone", jobTitle: "job_title", description: "description", shortName: "short_name" };

export interface LookupDef {
  name: LookupName;
  label: string;
  singular: string;
  table: string;
  minRole: CalendarRole;
  /** Legacy's column size for Name; new values only. */
  nameMax: number;
  extras: readonly { key: ExtraKey; label: string; max: number }[];
}

const SYS: CalendarRole = "Calendar.SysAdmin";
const ADMIN: CalendarRole = "Calendar.Administrator";

/** Legacy's lock-down (Admin/DynamicData/PageTemplates/ListDetails.aspx.cs:34-70; spec addendum §5.3). Sizes from Gcpe.Hub.Database/calendar/Tables. */
export const LOOKUPS: Readonly<Record<LookupName, LookupDef>> = {
  categories: { name: "categories", label: "Categories", singular: "category", table: "categories", minRole: SYS, nameMax: 50, extras: [] },
  cities: { name: "cities", label: "Cities", singular: "city", table: "cities", minRole: SYS, nameMax: 255, extras: [] },
  "comm-materials": { name: "comm-materials", label: "Comm materials", singular: "comm material", table: "comm_materials", minRole: SYS, nameMax: 100, extras: [] },
  "event-planners": {
    name: "event-planners", label: "Event planners", singular: "event planner", table: "event_planners", minRole: ADMIN, nameMax: 100,
    extras: [{ key: "phone", label: "Phone", max: 50 }, { key: "jobTitle", label: "Job title", max: 150 }],
  },
  "government-representatives": {
    name: "government-representatives", label: "Government representatives", singular: "government representative", table: "government_representatives", minRole: SYS, nameMax: 50,
    extras: [{ key: "description", label: "Description", max: 84 }],
  },
  initiatives: { name: "initiatives", label: "HQ initiatives", singular: "initiative", table: "initiatives", minRole: ADMIN, nameMax: 50, extras: [{ key: "shortName", label: "Short name", max: 40 }] },
  keywords: { name: "keywords", label: "HQ tags", singular: "HQ tag", table: "keywords", minRole: ADMIN, nameMax: 255, extras: [] },
  "nr-distributions": { name: "nr-distributions", label: "NR distributions", singular: "NR distribution", table: "nr_distributions", minRole: SYS, nameMax: 50, extras: [] },
  "nr-origins": { name: "nr-origins", label: "NR origins", singular: "NR origin", table: "nr_origins", minRole: SYS, nameMax: 50, extras: [] },
  "premier-requested": { name: "premier-requested", label: "Premier requested", singular: "Premier requested value", table: "premier_requested", minRole: SYS, nameMax: 50, extras: [] },
  videographers: { name: "videographers", label: "Digital (videographers)", singular: "videographer", table: "videographers", minRole: ADMIN, nameMax: 100, extras: [{ key: "jobTitle", label: "Job title", max: 150 }] },
};

export function lookupDef(name: string): LookupDef | null {
  return (LOOKUP_NAMES as readonly string[]).includes(name) ? LOOKUPS[name as LookupName] : null;
}

export function canEditLookup(def: LookupDef, level: number): boolean {
  return level >= CALENDAR_LEVELS[def.minRole];
}

export interface LookupRow {
  id: number;
  name: string;
  sortOrder: number;
  isActive: boolean;
  extras: Partial<Record<ExtraKey, string | null>>;
}

export class DuplicateLookupNameError extends Error {
  override name = "DuplicateLookupNameError";
}
export class LookupRowNotFoundError extends Error {
  override name = "LookupRowNotFoundError";
}
export class StaleLookupOrderError extends Error {
  override name = "StaleLookupOrderError";
}

/** A blank extra becomes null; every value is trimmed and held to legacy's size. */
export function lookupInputSchema(def: LookupDef) {
  const extras = Object.fromEntries(
    def.extras.map((e) => [
      e.key,
      z.string().trim().max(e.max, `${e.label}: at most ${e.max} characters`).nullable().optional().transform((v) => (v ? v : null)),
    ]),
  );
  return z
    .object({
      name: z.string().trim().min(1, "enter a name").max(def.nameMax, `at most ${def.nameMax} characters`),
      extras: z.object(extras).strict().default({}),
      isActive: z.boolean().optional(),
    })
    .strict();
}
export type LookupInput = { name: string; extras: Partial<Record<ExtraKey, string | null>>; isActive?: boolean };

const table = (def: LookupDef) => sql.identifier(def.table);

function columns(def: LookupDef): SQL {
  return sql.join(
    [sql`id`, sql`name`, sql`sort_order AS "sortOrder"`, sql`is_active AS "isActive"`, ...def.extras.map((e) => sql`${sql.identifier(EXTRA_COLUMNS[e.key])} AS ${sql.identifier(e.key)}`)],
    sql`, `,
  );
}

function toRow(def: LookupDef, r: Record<string, unknown>): LookupRow {
  return {
    id: Number(r.id),
    name: String(r.name),
    sortOrder: Number(r.sortOrder),
    isActive: r.isActive === true,
    extras: Object.fromEntries(def.extras.map((e) => [e.key, (r[e.key] as string | null) ?? null])),
  };
}

export async function listLookupRows(db: DbOrTx, def: LookupDef): Promise<LookupRow[]> {
  const r = await db.execute<Record<string, unknown>>(sql`SELECT ${columns(def)} FROM ${table(def)} ORDER BY sort_order, lower(name), id`);
  return r.rows.map((row) => toRow(def, row));
}

/** The lookup's aggregate lock: every write to one lookup takes it first, so a name check and the
 * write that relies on it can't interleave with another admin's. */
async function lockLookup(tx: Tx, def: LookupDef): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`calendar-lookup:${def.name}`}))`);
}

async function assertNameFree(tx: Tx, def: LookupDef, name: string, exceptId: number | null): Promise<void> {
  const except = exceptId === null ? sql`` : sql` AND id <> ${exceptId}`;
  const r = await tx.execute(sql`SELECT 1 FROM ${table(def)} WHERE is_active AND lower(name) = lower(${name})${except} LIMIT 1`);
  if (r.rows.length > 0) throw new DuplicateLookupNameError();
}

export async function createLookupRow(db: Db, def: LookupDef, input: LookupInput): Promise<LookupRow> {
  return db.transaction(async (tx) => {
    await lockLookup(tx, def);
    await assertNameFree(tx, def, input.name, null);
    const cols = [sql.identifier("name"), sql.identifier("sort_order"), ...def.extras.map((e) => sql.identifier(EXTRA_COLUMNS[e.key]))];
    const vals = [sql`${input.name}`, sql`(SELECT coalesce(max(sort_order), 0) + 1 FROM ${table(def)})`, ...def.extras.map((e) => sql`${input.extras[e.key] ?? null}`)];
    const r = await tx.execute<Record<string, unknown>>(
      sql`INSERT INTO ${table(def)} (${sql.join(cols, sql`, `)}) VALUES (${sql.join(vals, sql`, `)}) RETURNING ${columns(def)}`,
    );
    return toRow(def, r.rows[0]!);
  });
}

/** Replaces the row's name and extras, and its active flag when given. */
export async function updateLookupRow(db: Db, def: LookupDef, id: number, input: LookupInput): Promise<LookupRow> {
  return db.transaction(async (tx) => {
    await lockLookup(tx, def);
    const cur = await tx.execute<{ is_active: boolean }>(sql`SELECT is_active FROM ${table(def)} WHERE id = ${id} FOR UPDATE`);
    if (cur.rows.length === 0) throw new LookupRowNotFoundError();
    if (input.isActive ?? cur.rows[0]!.is_active) await assertNameFree(tx, def, input.name, id);
    const sets = [
      sql`name = ${input.name}`,
      ...def.extras.map((e) => sql`${sql.identifier(EXTRA_COLUMNS[e.key])} = ${input.extras[e.key] ?? null}`),
      ...(input.isActive === undefined ? [] : [sql`is_active = ${input.isActive}`]),
    ];
    const r = await tx.execute<Record<string, unknown>>(sql`UPDATE ${table(def)} SET ${sql.join(sets, sql`, `)} WHERE id = ${id} RETURNING ${columns(def)}`);
    return toRow(def, r.rows[0]!);
  });
}

/** Sets sort_order 1..n in the order given. The ids must be exactly the lookup's current rows. */
export async function reorderLookup(db: Db, def: LookupDef, ids: number[]): Promise<LookupRow[]> {
  return db.transaction(async (tx) => {
    await lockLookup(tx, def);
    const cur = await tx.execute<{ id: number }>(sql`SELECT id FROM ${table(def)} ORDER BY id FOR UPDATE`);
    const have = cur.rows.map((r) => Number(r.id));
    const want = [...ids].sort((a, b) => a - b);
    if (have.length !== want.length || have.some((v, i) => v !== want[i])) throw new StaleLookupOrderError();
    // ids are validated integers, so the array literal is safe to build as text.
    const list = `{${ids.join(",")}}`;
    await tx.execute(sql`UPDATE ${table(def)} AS t SET sort_order = o.ord FROM unnest(${list}::int[]) WITH ORDINALITY AS o(id, ord) WHERE t.id = o.id`);
    return listLookupRows(tx, def);
  });
}
