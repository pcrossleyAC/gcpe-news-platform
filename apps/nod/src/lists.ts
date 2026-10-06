import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { EventEnvelope, EventHandler, MediaListRecord, OrgRecord, TermRecord } from "@gcpe/events";
import { listCategories, lists } from "./db/schema";

/** Categories the public Subscribe API offers (spec §4). Media lists are staff-managed (4c). */
export const PUBLIC_CATEGORIES = ["ministries", "sectors", "themes", "tags", "emergency"] as const;
const TERM_CATEGORY = { sector: "sectors", theme: "themes", tag: "tags" } as const;

/** NRMS's media lists mirror into this category -- never a public one (global constraints). */
export const MEDIA_CATEGORY = "media-distribution-lists";

/** A media list's NoD list key: `media-distribution-lists:<key>`, lowercased. */
export function mediaListKey(key: string): string {
  return `${MEDIA_CATEGORY}:${key.toLowerCase()}`;
}

async function upsertList(tx: DbOrTx, category: string, key: string, name: string, sortOrder: number, active: boolean) {
  const k = key.toLowerCase();
  const row = { listKey: `${category}:${k}`, category, key: k, name, sortOrder, active };
  await tx.insert(lists).values(row).onConflictDoUpdate({ target: lists.listKey, set: { name, sortOrder, active } });
}
async function deactivate(tx: DbOrTx, category: string, key: string) {
  await tx.update(lists).set({ active: false }).where(eq(lists.listKey, `${category}:${key.toLowerCase()}`));
}

const onOrg: EventHandler = async (tx, e) => {
  const o = e.data as OrgRecord;
  await upsertList(tx, "ministries", o.key, o.displayName, o.sortOrder, o.isActive);
};
const onOrgGone: EventHandler = async (tx, e) => deactivate(tx, "ministries", (e.data as { key: string }).key);
const onTerm: EventHandler = async (tx, e) => {
  const t = e.data as TermRecord;
  const category = TERM_CATEGORY[t.kind as keyof typeof TERM_CATEGORY];
  if (!category) return; // services etc. are not subscribable
  await upsertList(tx, category, t.key, t.displayName ?? t.key, t.sortOrder, t.isActive);
};
const onTermGone: EventHandler = async (tx, e) => {
  const d = e.data as { kind: string; key: string };
  const category = TERM_CATEGORY[d.kind as keyof typeof TERM_CATEGORY];
  if (category) await deactivate(tx, category, d.key);
};

const onMediaList: EventHandler = async (tx, e) => {
  const m = e.data as MediaListRecord;
  await upsertList(tx, MEDIA_CATEGORY, m.key, m.displayName, m.sortOrder, m.isActive);
};
const onMediaListGone: EventHandler = async (tx, e) => deactivate(tx, MEDIA_CATEGORY, (e.data as { key: string }).key);

/** Core's org/sector/theme/tag events and NRMS's media_list events → NoD's `lists` (spec §3). */
export function listsHandler(event: EventEnvelope): EventHandler | undefined {
  if (event.source === "core") {
    switch (event.type) {
      case "org.upserted": return onOrg;
      case "org.deactivated": return onOrgGone;
      case "sector.upserted": case "theme.upserted": case "tag.upserted": return onTerm;
      case "sector.deactivated": case "theme.deactivated": case "tag.deactivated": return onTermGone;
      default: return undefined;
    }
  }
  if (event.source === "nrms") {
    switch (event.type) {
      case "media_list.created": case "media_list.updated": return onMediaList;
      case "media_list.deactivated": return onMediaListGone;
      default: return undefined;
    }
  }
  return undefined;
}

/** Legacy `SubscriptionItems/{categoryKey}`: active lists of an enabled public category. */
export async function publicListItems(db: DbOrTx, categoryKey: string): Promise<{ key: string; value: string }[]> {
  if (!(PUBLIC_CATEGORIES as readonly string[]).includes(categoryKey)) return [];
  const rows = await db
    .select({ key: lists.key, value: lists.name })
    .from(lists)
    .innerJoin(listCategories, eq(listCategories.key, lists.category))
    .where(and(eq(lists.category, categoryKey), eq(lists.active, true), eq(listCategories.enabled, true)))
    .orderBy(asc(lists.sortOrder), asc(lists.name));
  return rows;
}

/** The subset of `listKeys` a member of the public may subscribe to: `*`, or an active list in
 * an enabled public category. Order follows the input; duplicates removed. */
export async function activeListKeys(db: DbOrTx, listKeys: string[]): Promise<string[]> {
  const wanted = [...new Set(listKeys.map((k) => k.toLowerCase()))];
  const named = wanted.filter((k) => k !== "*");
  const found = named.length
    ? await db
        .select({ listKey: lists.listKey })
        .from(lists)
        .innerJoin(listCategories, eq(listCategories.key, lists.category))
        .where(and(inArray(lists.listKey, named), eq(lists.active, true), eq(listCategories.enabled, true), inArray(lists.category, [...PUBLIC_CATEGORIES])))
    : [];
  const ok = new Set(found.map((r) => r.listKey));
  return wanted.filter((k) => k === "*" || ok.has(k));
}

/** True until Core's reference data has reached NoD (no ministry list yet) — the stack then
 * asks Core to republish (Task 2 step 5). */
export async function needsReferenceData(db: DbOrTx): Promise<boolean> {
  const r = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${lists} WHERE ${lists.category} = 'ministries'`);
  return r.rows[0]!.n === 0;
}
