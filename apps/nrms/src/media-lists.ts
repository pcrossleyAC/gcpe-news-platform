/**
 * NRMS admin create/edit/deactivate for `media_lists` and the `media_list.created|updated|deactivated`
 * events that let NoD mirror them (spec §5.3, C47). Legacy rows (imported by
 * `import/reference.ts`'s `importMediaLists`) already satisfy the key format below — legacy
 * slugs like `001-a-daily-news` fit it — so admin-created lists are held to the same shape.
 */
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@gcpe/db-kit";
import { enqueueEvent, type MediaListRecord, type SubscriberConfig } from "@gcpe/events";
import { mediaLists } from "./db/schema";

/** Legacy slugs like `001-a-daily-news` fit this; immutable once a list is created. */
export const MEDIA_LIST_KEY = /^[a-z0-9][a-z0-9-]*$/;

export const createMediaListInputSchema = z.object({
  key: z.string().trim().min(1).max(100).regex(MEDIA_LIST_KEY, "lowercase letters, numbers and hyphens only"),
  displayName: z.string().trim().min(1),
  sortOrder: z.number().int().optional(),
});
export type CreateMediaListInput = z.infer<typeof createMediaListInputSchema>;

export const updateMediaListInputSchema = z.object({
  displayName: z.string().trim().min(1).optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateMediaListInput = z.infer<typeof updateMediaListInputSchema>;

/** → HTTP 409: `POST /api/media-lists` with a key that already exists. */
export class MediaListConflictError extends Error {
  constructor(public readonly key: string) {
    super(`A media list with key "${key}" already exists.`);
  }
}

/** → HTTP 404: no media list with that key. */
export class MediaListNotFoundError extends Error {
  constructor(public readonly key: string) {
    super(`No media list with key "${key}".`);
  }
}

const isUniqueViolation = (e: unknown): boolean => {
  for (let c: unknown = e; c && typeof c === "object"; c = (c as { cause?: unknown }).cause) {
    if ((c as { code?: unknown }).code === "23505") return true;
  }
  return false;
};

function toRecord(row: { key: string; displayName: string; sortOrder: number; isActive: boolean }): MediaListRecord {
  return { key: row.key, displayName: row.displayName, sortOrder: row.sortOrder, isActive: row.isActive };
}

const aggregateId = (key: string) => `media-list:${key}`;
const COLUMNS = { key: mediaLists.key, displayName: mediaLists.displayName, sortOrder: mediaLists.sortOrder, isActive: mediaLists.isActive };

/** Creates a media list and emits `media_list.created` in the same transaction. 409 on a duplicate key. */
export async function createMediaList(db: Db, input: CreateMediaListInput, subscribers: SubscriberConfig[]): Promise<MediaListRecord> {
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(mediaLists)
        .values({ key: input.key, displayName: input.displayName, sortOrder: input.sortOrder ?? 0, isActive: true })
        .returning(COLUMNS);
      const record = toRecord(row!);
      await enqueueEvent(tx, { type: "media_list.created", source: "nrms", aggregateId: aggregateId(record.key), data: record }, subscribers);
      return record;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new MediaListConflictError(input.key);
    throw e;
  }
}

/**
 * Updates a media list and emits `media_list.updated`, or `media_list.deactivated` (data: `{ key
 * }`) specifically when `isActive` is being set to `false` on a list that was active. 404 on an
 * unknown key. The key itself is immutable and never part of the input.
 */
export async function updateMediaList(db: Db, key: string, input: UpdateMediaListInput, subscribers: SubscriberConfig[]): Promise<MediaListRecord> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select(COLUMNS).from(mediaLists).where(eq(mediaLists.key, key)).for("update");
    if (!existing) throw new MediaListNotFoundError(key);

    const set = {
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    };
    const [row] = Object.keys(set).length ? await tx.update(mediaLists).set(set).where(eq(mediaLists.key, key)).returning(COLUMNS) : [existing];
    const record = toRecord(row!);

    const deactivating = existing.isActive && input.isActive === false;
    if (deactivating) {
      await enqueueEvent(tx, { type: "media_list.deactivated", source: "nrms", aggregateId: aggregateId(key), data: { key } }, subscribers);
    } else {
      await enqueueEvent(tx, { type: "media_list.updated", source: "nrms", aggregateId: aggregateId(key), data: record }, subscribers);
    }
    return record;
  });
}

/** Emits `media_list.updated` for every row (active or not), e.g. so a newly-wired NoD can catch up. Returns the count. */
export async function republishMediaLists(db: Db, subscribers: SubscriberConfig[]): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx.select(COLUMNS).from(mediaLists).orderBy(asc(mediaLists.sortOrder), asc(mediaLists.displayName));
    for (const row of rows) {
      const record = toRecord(row);
      await enqueueEvent(tx, { type: "media_list.updated", source: "nrms", aggregateId: aggregateId(record.key), data: record }, subscribers);
    }
    return rows.length;
  });
}
