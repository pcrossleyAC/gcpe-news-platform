import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { EventEnvelope, EventHandler, MediaListRecord, OrgRecord, OrgSucceeded, TermRecord } from "@gcpe/events";
import { listCategories, lists, subscriberHistory, subscriptions } from "./db/schema";

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
  // A non-public organization (Q54) is kept as an inactive list: not offered on the subscribe
  // page and not subscribable, the same as a deactivated one.
  await upsertList(tx, "ministries", o.key, o.displayName, o.sortOrder, o.isActive && o.isPublic);
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

/** Actor on the history lines a ministry succession writes. */
export const SUCCESSION_ACTOR = "system: ministry succession";

/**
 * Moves every subscription to `ministries:<from>` onto each of `to` (one INSERT … ON CONFLICT DO
 * NOTHING per successor, so a subscriber already on a successor keeps exactly one row), then
 * deletes the `from` rows and writes one `list-moved` history line per subscriber moved, taken
 * from the deleted set. Idempotent: once the `from` rows are gone a repeat moves nothing and
 * writes no history. Returns the number of subscriptions moved.
 */
export async function moveMinistrySubscribers(tx: DbOrTx, from: string, to: string[], actor: string): Promise<number> {
  const fromKey = `ministries:${from.toLowerCase()}`;
  const toKeys = [...new Set(to.map((k) => `ministries:${k.toLowerCase()}`))].filter((k) => k !== fromKey);
  if (toKeys.length === 0) return 0;
  for (const toKey of toKeys) {
    await tx.execute(sql`
      INSERT INTO ${subscriptions} (subscriber_id, list_key)
      SELECT subscriber_id, ${toKey} FROM ${subscriptions} WHERE list_key = ${fromKey}
      ON CONFLICT DO NOTHING`);
  }
  const moved = await tx.delete(subscriptions).where(eq(subscriptions.listKey, fromKey)).returning({ subscriberId: subscriptions.subscriberId });
  if (moved.length === 0) return 0;
  const detail = `${fromKey} → ${toKeys.join(", ")}`;
  await tx.insert(subscriberHistory).values(moved.map((m) => ({ subscriberId: m.subscriberId, actor, action: "list-moved", detail })));
  return moved.length;
}

const onOrgSucceeded: EventHandler = async (tx, e) => {
  const s = e.data as OrgSucceeded;
  if (!s.moveSubscribers) return;
  await moveMinistrySubscribers(tx, s.key, s.successorKeys, SUCCESSION_ACTOR);
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
      case "org.succeeded": return onOrgSucceeded;
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

/** Display order for lists: staff's own order first (nulls last), then the source's, then name. */
export const LIST_ORDER = [sql`${lists.staffSortOrder} ASC NULLS LAST`, asc(lists.sortOrder), asc(lists.name)];

/** Legacy `SubscriptionItems/{categoryKey}`: active, staff-enabled lists of an enabled public category. */
export async function publicListItems(db: DbOrTx, categoryKey: string): Promise<{ key: string; value: string }[]> {
  if (!(PUBLIC_CATEGORIES as readonly string[]).includes(categoryKey)) return [];
  const rows = await db
    .select({ key: lists.key, value: lists.name })
    .from(lists)
    .innerJoin(listCategories, eq(listCategories.key, lists.category))
    .where(and(eq(lists.category, categoryKey), eq(lists.active, true), eq(lists.enabled, true), eq(listCategories.enabled, true)))
    .orderBy(...LIST_ORDER);
  return rows;
}

/** The subset of `listKeys` a member of the public may subscribe to: `*`, or an active,
 * staff-enabled list in an enabled public category. Order follows the input; duplicates removed. */
export async function activeListKeys(db: DbOrTx, listKeys: string[]): Promise<string[]> {
  const wanted = [...new Set(listKeys.map((k) => k.toLowerCase()))];
  const named = wanted.filter((k) => k !== "*");
  const found = named.length
    ? await db
        .select({ listKey: lists.listKey })
        .from(lists)
        .innerJoin(listCategories, eq(listCategories.key, lists.category))
        .where(and(inArray(lists.listKey, named), eq(lists.active, true), eq(lists.enabled, true), eq(listCategories.enabled, true), inArray(lists.category, [...PUBLIC_CATEGORIES])))
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
