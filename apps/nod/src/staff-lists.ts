/**
 * Lists & categories for the staff section (spec §8). Core and NRMS own list names, `active` and
 * their own sort order; staff own whether a list or category is offered and the order staff and
 * the public see. Media lists are NRMS's entirely (legacy refused to edit them in NoD too).
 */
import { asc, eq, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import { listCategories, lists } from "./db/schema";
import { LIST_ORDER, MEDIA_CATEGORY } from "./lists";
import { writeOpsLog } from "./settings";

export type NamesFrom = "Core" | "NRMS" | "NoD";
const NAMES_FROM: Record<string, NamesFrom> = { ministries: "Core", sectors: "Core", themes: "Core", tags: "Core", [MEDIA_CATEGORY]: "NRMS" };

export interface StaffList {
  listKey: string;
  key: string;
  name: string;
  /** The source's own state (Core/NRMS); a retired list stays visible here. */
  active: boolean;
  /** Staff's switch: offered for new subscriptions. */
  enabled: boolean;
  /** Active subscribers holding this list. */
  subscribers: number;
}

export interface StaffCategory {
  key: string;
  name: string;
  enabled: boolean;
  namesFrom: NamesFrom;
  /** False for media lists: names, order and state are changed in NRMS. */
  editable: boolean;
  lists: StaffList[];
}

export interface StaffListsView {
  /** Active subscribers on "All news" (`*`). */
  allNews: number;
  categories: StaffCategory[];
}

export class ListNotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "ListNotFoundError";
  }
}
export class ManagedInNrmsError extends Error {
  constructor() {
    super("managed-in-nrms");
    this.name = "ManagedInNrmsError";
  }
}
/** The order sent isn't exactly the current set: a list arrived or left since the screen loaded. */
export class OrderOutOfDateError extends Error {
  constructor() {
    super("order-out-of-date");
    this.name = "OrderOutOfDateError";
  }
}

export async function staffListsView(db: DbOrTx): Promise<StaffListsView> {
  const cats = await db.select().from(listCategories).orderBy(asc(listCategories.sortOrder), asc(listCategories.name));
  const rows = await db
    .select({ listKey: lists.listKey, category: lists.category, key: lists.key, name: lists.name, active: lists.active, enabled: lists.enabled })
    .from(lists)
    .orderBy(...LIST_ORDER);
  // One pass over subscriptions (bounded by subscriber count, never deliveries).
  const { rows: counts } = await db.execute<{ list_key: string; n: number }>(sql`
    SELECT sub.list_key, count(*)::int AS n
      FROM subscriptions sub
      JOIN subscribers s ON s.id = sub.subscriber_id
     WHERE s.status = 'active'
     GROUP BY sub.list_key`);
  const count = new Map(counts.map((c) => [c.list_key, c.n]));
  return {
    allNews: count.get("*") ?? 0,
    categories: cats.map((c) => ({
      key: c.key,
      name: c.name,
      enabled: c.enabled,
      namesFrom: NAMES_FROM[c.key] ?? "NoD",
      editable: c.key !== MEDIA_CATEGORY,
      lists: rows
        .filter((l) => l.category === c.key)
        .map((l) => ({ listKey: l.listKey, key: l.key, name: l.name, active: l.active, enabled: l.enabled, subscribers: count.get(l.listKey) ?? 0 })),
    })),
  };
}

function isPermutation(have: string[], want: string[]): boolean {
  return have.length === want.length && new Set(want).size === want.length && want.every((k) => have.includes(k));
}

export async function setCategoryEnabled(db: Db, key: string, enabled: boolean, actor: string): Promise<{ changed: boolean }> {
  if (key === MEDIA_CATEGORY) throw new ManagedInNrmsError();
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ enabled: listCategories.enabled }).from(listCategories).where(eq(listCategories.key, key)).for("update");
    if (!row) throw new ListNotFoundError();
    if (row.enabled === enabled) return { changed: false };
    await tx.update(listCategories).set({ enabled }).where(eq(listCategories.key, key));
    await writeOpsLog(tx, actor, enabled ? "category-enabled" : "category-disabled", key);
    return { changed: true };
  });
}

export async function setListEnabled(db: Db, listKey: string, enabled: boolean, actor: string): Promise<{ changed: boolean }> {
  const key = listKey.toLowerCase();
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ category: lists.category, enabled: lists.enabled }).from(lists).where(eq(lists.listKey, key)).for("update");
    if (!row) throw new ListNotFoundError();
    if (row.category === MEDIA_CATEGORY) throw new ManagedInNrmsError();
    if (row.enabled === enabled) return { changed: false };
    await tx.update(lists).set({ enabled }).where(eq(lists.listKey, key));
    await writeOpsLog(tx, actor, enabled ? "list-enabled" : "list-disabled", key);
    return { changed: true };
  });
}

/** Category order: the staff screens and the preferences form. The public Subscribe API asks
 * per category, so this doesn't change the public page. */
export async function reorderCategories(db: Db, keys: string[], actor: string): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx.select({ key: listCategories.key }).from(listCategories).for("update");
    if (!isPermutation(rows.map((r) => r.key), keys)) throw new OrderOutOfDateError();
    for (const [i, key] of keys.entries()) await tx.update(listCategories).set({ sortOrder: i + 1 }).where(eq(listCategories.key, key));
    await writeOpsLog(tx, actor, "categories-reordered");
  });
}

/** List order within one category, every list included (retired ones too, so their slot is
 * kept if Core brings them back). This order is what the public subscribe page shows. */
export async function reorderLists(db: Db, category: string, listKeys: string[], actor: string): Promise<void> {
  if (category === MEDIA_CATEGORY) throw new ManagedInNrmsError();
  const wanted = listKeys.map((k) => k.toLowerCase());
  await db.transaction(async (tx) => {
    const [cat] = await tx.select({ key: listCategories.key }).from(listCategories).where(eq(listCategories.key, category));
    if (!cat) throw new ListNotFoundError();
    const rows = await tx.select({ listKey: lists.listKey }).from(lists).where(eq(lists.category, category)).for("update");
    if (!isPermutation(rows.map((r) => r.listKey), wanted)) throw new OrderOutOfDateError();
    for (const [i, listKey] of wanted.entries()) await tx.update(lists).set({ staffSortOrder: i + 1 }).where(eq(lists.listKey, listKey));
    await writeOpsLog(tx, actor, "lists-reordered", category);
  });
}
