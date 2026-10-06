import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@gcpe/db-kit";
import { envelopeByteLength, MAX_EVENT_BYTES, releaseRecordSchema, sizingEnvelope, type ReleaseRecord } from "@gcpe/events";
import { releases, type ReleaseContent, type ReleaseRow } from "./db/schema";

export const releaseDraftSchema = releaseRecordSchema
  .omit({ publishDate: true, timestamp: true, atomId: true, renditions: true })
  .extend({ key: z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/, "letters, digits and hyphens only") });
export type ReleaseDraft = z.infer<typeof releaseDraftSchema>;

export class ReleaseExistsError extends Error {}
export class ReleaseNotFoundError extends Error {}
export class ReleaseAlreadyPublishedError extends Error {}
/** Thrown by {@link createDraft} when the release, once published, would produce an outbox
 * envelope over {@link MAX_EVENT_BYTES} — rejected up front so it can never wedge the
 * publisher (see publisher.ts's per-release isolation for the defence-in-depth backstop). */
export class ReleaseTooLargeError extends Error {}

/**
 * Builds the record the release would publish as (with a placeholder date, since the real
 * publishDate/timestamp aren't known until publishDue runs), validates it against
 * releaseRecordSchema, and checks that the largest envelope carrying it — @gcpe/events'
 * sizingEnvelope, the same sizing enqueueEvent's own check uses, with the not-yet-assigned
 * sequence counted at its maximum width — fits under MAX_EVENT_BYTES.
 */
function assertPublishable(key: string, kind: ReleaseDraft["kind"], content: ReleaseContent): void {
  const placeholder = new Date(0).toISOString();
  const record: ReleaseRecord = { ...content, key, kind, publishDate: placeholder, timestamp: placeholder, atomId: null, renditions: null };
  releaseRecordSchema.parse(record);
  const bytes = envelopeByteLength(sizingEnvelope({ type: "release.published", source: "nrms", aggregateId: key, data: record }));
  if (bytes > MAX_EVENT_BYTES) {
    throw new ReleaseTooLargeError(`release ${key} would publish as up to ${bytes} bytes; the limit is MAX_EVENT_BYTES (${MAX_EVENT_BYTES})`);
  }
}

const byKey = (key: string) => sql`lower(${releases.key}) = lower(${key})`;

export async function getRelease(db: Db, key: string): Promise<ReleaseRow | undefined> {
  const [row] = await db.select().from(releases).where(byKey(key));
  return row;
}

export async function createDraft(db: Db, draft: ReleaseDraft): Promise<void> {
  const { key, kind, ...content } = draft;
  assertPublishable(key, kind, content satisfies ReleaseContent);
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
  if (Number.isNaN(publishAt.getTime())) throw new RangeError(`publishAt is an invalid Date for release ${key}`);
  const row = await getRelease(db, key);
  if (!row) throw new ReleaseNotFoundError(key);
  const updated = await db
    .update(releases)
    .set({ status: "scheduled", publishAt, lastError: null, updatedAt: new Date() })
    .where(sql`${byKey(key)} AND ${releases.status} <> 'published'`)
    .returning({ key: releases.key });
  if (updated.length === 0) throw new ReleaseAlreadyPublishedError(key);
}
