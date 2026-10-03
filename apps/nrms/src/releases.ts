import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@gcpe/db-kit";
import { releaseRecordSchema } from "@gcpe/events";
import { releases, type ReleaseContent, type ReleaseRow } from "./db/schema";

export const releaseDraftSchema = releaseRecordSchema
  .omit({ publishDate: true, timestamp: true, atomId: true, renditions: true })
  .extend({ key: z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/, "letters, digits and hyphens only") });
export type ReleaseDraft = z.infer<typeof releaseDraftSchema>;

export class ReleaseExistsError extends Error {}
export class ReleaseNotFoundError extends Error {}
export class ReleaseAlreadyPublishedError extends Error {}

const byKey = (key: string) => sql`lower(${releases.key}) = lower(${key})`;

export async function getRelease(db: Db, key: string): Promise<ReleaseRow | undefined> {
  const [row] = await db.select().from(releases).where(byKey(key));
  return row;
}

export async function createDraft(db: Db, draft: ReleaseDraft): Promise<void> {
  const { key, kind, ...content } = draft;
  try {
    await db.insert(releases).values({ key, kind, content: content satisfies ReleaseContent });
  } catch (e) {
    // drizzle-orm's shared pg-core session wraps every driver error in a DrizzleQueryError,
    // putting the original pg error (with its `.code`) on `.cause` (verified: pg-core/session.js
    // queryWithCache catches and rethrows `new DrizzleQueryError(queryString, params, e)`).
    if ((e as { cause?: { code?: string } }).cause?.code === "23505") throw new ReleaseExistsError(key);
    throw e;
  }
}

export async function scheduleRelease(db: Db, key: string, publishAt: Date): Promise<void> {
  const row = await getRelease(db, key);
  if (!row) throw new ReleaseNotFoundError(key);
  const updated = await db
    .update(releases)
    .set({ status: "scheduled", publishAt, updatedAt: new Date() })
    .where(sql`${byKey(key)} AND ${releases.status} <> 'published'`)
    .returning({ key: releases.key });
  if (updated.length === 0) throw new ReleaseAlreadyPublishedError(key);
}
