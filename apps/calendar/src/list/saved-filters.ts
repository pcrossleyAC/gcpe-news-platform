import { and, asc, eq, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import { listFilterSchema, type ListFilter, type SavedFilterView } from "@gcpe/calendar-contract";
import { savedFilters } from "../db/schema";
import { lockUserData } from "../users";

export const SAVED_FILTER_LIMIT = 200;

export class SavedFilterNotFoundError extends Error {
  override name = "SavedFilterNotFoundError";
}
export class SavedFilterOrderError extends Error {
  override name = "SavedFilterOrderError";
  constructor() {
    super("Your queries changed since you loaded them: reload and try again");
  }
}
export class SavedFilterLimitError extends Error {
  override name = "SavedFilterLimitError";
  constructor() {
    super(`You can keep up to ${SAVED_FILTER_LIMIT} queries: delete one first`);
  }
}

/** A stored filter that no longer reads as one comes back null, so the list of queries still loads. */
const viewOf = (r: typeof savedFilters.$inferSelect): SavedFilterView => {
  const parsed = listFilterSchema.safeParse(r.filter);
  return { id: r.id, name: r.name, sortOrder: r.sortOrder, filter: parsed.success ? parsed.data : null };
};
const mine = (ownerId: string) => and(eq(savedFilters.ownerId, ownerId), eq(savedFilters.isActive, true));

export async function listSavedFilters(db: DbOrTx, ownerId: string): Promise<SavedFilterView[]> {
  return (await db.select().from(savedFilters).where(mine(ownerId)).orderBy(asc(savedFilters.sortOrder), asc(savedFilters.id))).map(viewOf);
}

export function createSavedFilter(db: Db, ownerId: string, input: { name: string; filter: ListFilter }): Promise<SavedFilterView> {
  return db.transaction(async (tx) => {
    await lockUserData(tx, ownerId);
    const [c] = await tx
      .select({ n: sql<number>`count(*)`.mapWith(Number), max: sql<number>`coalesce(max(${savedFilters.sortOrder}), 0)`.mapWith(Number) })
      .from(savedFilters)
      .where(mine(ownerId));
    if (c!.n >= SAVED_FILTER_LIMIT) throw new SavedFilterLimitError();
    const [row] = await tx.insert(savedFilters).values({ ownerId, name: input.name, filter: input.filter, sortOrder: c!.max + 1 }).returning();
    return viewOf(row!);
  });
}

export async function renameSavedFilter(db: Db, ownerId: string, id: number, name: string): Promise<SavedFilterView> {
  return db.transaction(async (tx) => {
    await lockUserData(tx, ownerId);
    const [row] = await tx.update(savedFilters).set({ name }).where(and(eq(savedFilters.id, id), mine(ownerId))).returning();
    if (!row) throw new SavedFilterNotFoundError();
    return viewOf(row);
  });
}

/** Legacy kept a deleted query, inactive (ActivityFilter.asmx.cs:82-90). */
export async function deleteSavedFilter(db: Db, ownerId: string, id: number): Promise<void> {
  await db.transaction(async (tx) => {
    await lockUserData(tx, ownerId);
    const rows = await tx.update(savedFilters).set({ isActive: false }).where(and(eq(savedFilters.id, id), mine(ownerId))).returning({ id: savedFilters.id });
    if (rows.length === 0) throw new SavedFilterNotFoundError();
  });
}

/** Sets the order 1..n. The ids must be exactly the owner's active queries. */
export function reorderSavedFilters(db: Db, ownerId: string, ids: number[]): Promise<SavedFilterView[]> {
  return db.transaction(async (tx) => {
    await lockUserData(tx, ownerId);
    const have = (await tx.select({ id: savedFilters.id }).from(savedFilters).where(mine(ownerId))).map((r) => r.id).sort((a, b) => a - b);
    const want = [...ids].sort((a, b) => a - b);
    if (have.length !== want.length || have.some((v, i) => v !== want[i])) throw new SavedFilterOrderError();
    for (const [n, id] of ids.entries()) await tx.update(savedFilters).set({ sortOrder: n + 1 }).where(eq(savedFilters.id, id));
    return listSavedFilters(tx, ownerId);
  });
}
