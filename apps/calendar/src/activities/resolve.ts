import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@gcpe/db-kit";
import type { ActivityFields, CalendarRules, FieldError } from "@gcpe/calendar-contract";
import { can, isOwnMinistry } from "../capabilities";
import { commContacts, keywords, orgs, terms } from "../db/schema";
import type { Viewer } from "../visibility";
import type { StoredActivity } from "./store";

export interface Resolution {
  errors: FieldError[];
  categoryNames: string[];
  contactMinistryAbbreviation: string | null;
  /** Existing keywords, matched case-insensitively (active first). */
  keywordIds: number[];
  /** Names no keyword has yet; created on save (C146). */
  keywordsToCreate: string[];
}

interface Ctx {
  actor: Viewer;
  rules: CalendarRules;
  /** The stored activity and its fields, on an update or clone: an inactive value it already has stays allowed. */
  previous: { stored: StoredActivity; fields: ActivityFields } | null;
}

const SINGLE = [
  ["cityId", "cities", "city"],
  ["governmentRepresentativeId", "government_representatives", "representative"],
  ["premierRequestedId", "premier_requested", "Premier Requested value"],
  ["nrDistributionId", "nr_distributions", "distribution"],
  ["eventPlannerId", "event_planners", "event planner"],
  ["videographerId", "videographers", "Digital contact"],
  ["nrOriginId", "nr_origins", "origin"],
] as const;

async function lookupRows(tx: Tx, table: string, ids: number[]): Promise<Map<number, { name: string; isActive: boolean }>> {
  if (ids.length === 0) return new Map();
  const r = await tx.execute<{ id: number; name: string; is_active: boolean }>(sql`SELECT id, name, is_active FROM ${sql.identifier(table)} WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
  return new Map(r.rows.map((x) => [Number(x.id), { name: x.name, isActive: x.is_active }]));
}

/**
 * Checks every reference the save names (spec addendum §7.2, C156) and resolves HQ Tags by name.
 * An inactive value is allowed only when the activity already has it, as legacy's dropdowns
 * offered inactive rows only when selected (DropDownListManager.cs:297).
 */
export async function resolveReferences(tx: Tx, i: ActivityFields, ctx: Ctx): Promise<Resolution> {
  const errors: FieldError[] = [];
  const add = (field: string, message: string) => errors.push({ field, message });
  const prev = ctx.previous;

  for (const [field, table, label] of SINGLE) {
    const v = i[field];
    if (v === null) continue;
    const row = (await lookupRows(tx, table, [v])).get(v);
    if (!row) add(field, `That ${label} doesn't exist`);
    else if (!row.isActive && prev?.fields[field] !== v) add(field, `That ${label} is no longer in use`);
  }

  let categoryNames: string[] = [];
  if (i.categoryId !== null) {
    const unchanged = prev?.fields.categoryId === i.categoryId;
    const ids = unchanged ? prev!.stored.joins.categoryIds : [i.categoryId];
    const rows = await lookupRows(tx, "categories", ids);
    const row = rows.get(i.categoryId);
    categoryNames = [...rows.values()].map((r) => r.name);
    if (!row) add("categoryId", "That category doesn't exist");
    else if (!unchanged && row.name === ctx.rules.hqPlaceholderCategoryName) {
      if (!can.useHqPlaceholder(ctx.actor)) add("categoryId", "Only HQ can use this category");
    } else if (!unchanged && !row.isActive) add("categoryId", "That category is no longer in use");
  }

  for (const [field, table, label] of [["commMaterialIds", "comm_materials", "comm material"], ["initiativeIds", "initiatives", "initiative"]] as const) {
    const rows = await lookupRows(tx, table, i[field]);
    const had = new Set(prev?.fields[field] ?? []);
    for (const v of i[field]) {
      const row = rows.get(v);
      if (!row) add(field, `A chosen ${label} doesn't exist`);
      else if (!row.isActive && !had.has(v)) add(field, `${row.name}: no longer in use`);
    }
  }

  let contactMinistryAbbreviation: string | null = null;
  if (i.contactMinistryKey !== null) {
    const [org] = await tx.select().from(orgs).where(eq(orgs.key, i.contactMinistryKey));
    contactMinistryAbbreviation = org?.abbreviation ?? null;
    const changed = prev?.fields.contactMinistryKey !== i.contactMinistryKey;
    if (!org) add("contactMinistryKey", "That ministry doesn't exist");
    else if (changed) {
      if (!org.isActive) add("contactMinistryKey", "That ministry is no longer active");
      else if (org.abbreviation && ctx.rules.contactMinistryExcludedAbbreviations.includes(org.abbreviation)) add("contactMinistryKey", "That ministry can't lead an activity");
      else if (!ctx.actor.isHq && !isOwnMinistry(ctx.actor, i.contactMinistryKey)) add("contactMinistryKey", "You can only choose one of your ministries");
    }
  }

  if (i.commContactId !== null) {
    const [c] = await tx.select().from(commContacts).where(eq(commContacts.id, i.commContactId));
    if (!c) add("commContactId", "That comm contact doesn't exist");
    else if (c.ministryKey !== i.contactMinistryKey) add("commContactId", "Choose a comm contact of the lead ministry");
    else if (!c.isActive && prev?.fields.commContactId !== i.commContactId) add("commContactId", "That comm contact is no longer active");
  }

  for (const [field, kind] of [["sectorKeys", "sector"], ["themeKeys", "theme"], ["tagKeys", "tag"]] as const) {
    const wanted = [...new Set(i[field])];
    if (wanted.length === 0) continue;
    const rows = await tx.select().from(terms).where(and(eq(terms.kind, kind), inArray(terms.key, wanted)));
    const had = new Set(prev?.fields[field] ?? []);
    for (const k of wanted) {
      const t = rows.find((r) => r.key === k);
      if (!t) add(field, `Unknown ${kind}: ${k}`);
      else if (!t.isActive && !had.has(k)) add(field, `${t.displayName}: no longer in use`);
    }
  }

  const shared = [...new Set(i.sharedWithKeys)];
  if (shared.length) {
    const rows = await tx.select().from(orgs).where(inArray(orgs.key, shared));
    const had = new Set(prev?.fields.sharedWithKeys ?? []);
    for (const k of shared) {
      const o = rows.find((r) => r.key === k);
      if (!o) add("sharedWithKeys", `Unknown ministry: ${k}`);
      else if (!had.has(k) && !o.isActive) add("sharedWithKeys", `${o.displayName}: no longer active`);
      else if (!had.has(k) && o.abbreviation && ctx.rules.sharedWithExcludedAbbreviations.includes(o.abbreviation)) add("sharedWithKeys", `${o.displayName} can't be shared with`);
    }
  }

  // HQ Tags by name, case-insensitively, each once. Legacy matched names under SQL Server's
  // case-insensitive collation, inactive keywords included.
  const byLower = new Map<string, string>();
  for (const raw of i.keywordNames) {
    const name = raw.trim();
    if (name && !byLower.has(name.toLowerCase())) byLower.set(name.toLowerCase(), name);
  }
  const keywordIds: number[] = [];
  const keywordsToCreate: string[] = [];
  if (byLower.size) {
    const rows = await tx
      .select({ id: keywords.id, lower: sql<string>`lower(${keywords.name})`, isActive: keywords.isActive })
      .from(keywords)
      .where(inArray(sql`lower(${keywords.name})`, [...byLower.keys()]))
      .orderBy(sql`${keywords.isActive} DESC`, keywords.id);
    for (const [lower, name] of byLower) {
      const match = rows.find((r) => r.lower === lower);
      if (match) keywordIds.push(match.id);
      else keywordsToCreate.push(name);
    }
  }

  return { errors, categoryNames, contactMinistryAbbreviation, keywordIds, keywordsToCreate };
}

/** Creates HQ Tags under the keyword lookup's lock, which the caller already holds. */
export async function createKeywords(tx: Tx, names: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const name of names) {
    const r = await tx.execute<{ id: number }>(sql`INSERT INTO keywords (name, sort_order) VALUES (${name}, (SELECT coalesce(max(sort_order), 0) + 1 FROM keywords)) RETURNING id`);
    ids.push(Number(r.rows[0]!.id));
  }
  return ids;
}
