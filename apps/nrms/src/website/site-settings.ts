import { desc, eq, sql } from "drizzle-orm";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import { enqueueEvent, type SubscriberConfig } from "@gcpe/events";
import {
  differingSections,
  siteSettingsSchema,
  validateSiteSettings,
  withSection,
  type FieldError,
  type SectionKey,
  type SiteSettings,
} from "@gcpe/site-settings";
import { siteSettingsDrafts, siteSettingsRevisions } from "../db/schema";
import type { Actor } from "../releases/store";
import { writeSiteLog } from "./events";

/**
 * Site settings storage and publishing (site-settings plan, Task 3; spec "Storage and
 * publishing — NRMS"). Published revisions are numbered 1, 2, …; the newest is live. Each editor
 * has at most one draft, remembering the revision it started from — that base revision is the
 * publish concurrency token (it replaces the legacy blob ETag).
 */

/** Two-int advisory key in the "gcpe" space (see db-kit's MIGRATION_LOCK); 7 is site-settings publishing. */
export const SITE_SETTINGS_PUBLISH_LOCK = [0x67637065, 7] as const;

export interface LiveInfo {
  revision: number;
  publishedAt: string;
  publishedBy: string;
  note: string | null;
}

export interface SettingsState {
  live: LiveInfo | null;
  document: SiteSettings;
  draft: { baseRevision: number | null; updatedAt: string } | null;
  baseRevision: number | null;
  errors: FieldError[];
}

export type PublishResult =
  | { result: "published"; revision: number }
  | { result: "invalid"; errors: FieldError[] }
  | { result: "conflict"; live: LiveInfo; differing: SectionKey[] };

export interface SectionInput {
  section: SectionKey;
  value: unknown;
}

const infoColumns = {
  revision: siteSettingsRevisions.revision,
  publishedAt: siteSettingsRevisions.publishedAt,
  publishedBy: siteSettingsRevisions.publishedByName,
  note: siteSettingsRevisions.note,
};

const toInfo = (r: { revision: number; publishedAt: Date; publishedBy: string; note: string | null }): LiveInfo => ({
  revision: r.revision,
  publishedAt: r.publishedAt.toISOString(),
  publishedBy: r.publishedBy,
  note: r.note,
});

async function readLive(db: DbOrTx): Promise<{ info: LiveInfo; document: SiteSettings } | null> {
  const [row] = await db.select({ ...infoColumns, document: siteSettingsRevisions.document }).from(siteSettingsRevisions).orderBy(desc(siteSettingsRevisions.revision)).limit(1);
  return row ? { info: toInfo(row), document: row.document } : null;
}

async function readDraft(db: DbOrTx, actor: Actor) {
  const [row] = await db.select().from(siteSettingsDrafts).where(eq(siteSettingsDrafts.editorId, actor.id));
  return row ?? null;
}

/** Parses one section's value with its structural schema (a ZodError ⇒ 400) and overlays it on `doc`. */
function overlay(doc: SiteSettings, input: SectionInput): SiteSettings {
  const value = siteSettingsSchema.shape[input.section].parse(input.value) as SiteSettings[SectionKey];
  return withSection(doc, input.section, value);
}

async function upsertDraft(db: DbOrTx, actor: Actor, document: SiteSettings, baseRevision: number | null): Promise<void> {
  await db
    .insert(siteSettingsDrafts)
    .values({ editorId: actor.id, document, baseRevision })
    .onConflictDoUpdate({ target: siteSettingsDrafts.editorId, set: { document, baseRevision, updatedAt: sql`now()` } });
}

/** What the editor sees: their draft, else live, else the tenant defaults — and its problems. */
export async function getSettingsState(db: DbOrTx, actor: Actor, defaults: SiteSettings): Promise<SettingsState> {
  const [live, draft] = await Promise.all([readLive(db), readDraft(db, actor)]);
  const document = draft?.document ?? live?.document ?? defaults;
  return {
    live: live?.info ?? null,
    document,
    draft: draft ? { baseRevision: draft.baseRevision, updatedAt: draft.updatedAt.toISOString() } : null,
    baseRevision: draft ? draft.baseRevision : (live?.info.revision ?? null),
    errors: validateSiteSettings(document),
  };
}

/** Save draft always saves (with the base revision the screen loaded), then reports validation problems. */
export async function saveDraft(
  db: Db,
  actor: Actor,
  defaults: SiteSettings,
  input: SectionInput & { baseRevision: number | null },
): Promise<SettingsState> {
  await db.transaction(async (tx) => {
    const [live, draft] = await Promise.all([readLive(tx), readDraft(tx, actor)]);
    await upsertDraft(tx, actor, overlay(draft?.document ?? live?.document ?? defaults, input), input.baseRevision);
  });
  return getSettingsState(db, actor, defaults);
}

/**
 * Publishes `document` as revision live+1 under the publish lock: invalid ⇒ nothing written;
 * live ≠ `baseRevision` ⇒ conflict, nothing written; else insert, delete the publisher's draft
 * (other editors keep theirs), log, and enqueue `site.settings.published`.
 */
async function publishDocument(
  tx: Tx,
  actor: Actor,
  subs: SubscriberConfig[],
  document: SiteSettings,
  baseRevision: number | null,
  note: string | null,
): Promise<PublishResult> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${SITE_SETTINGS_PUBLISH_LOCK[0]}, ${SITE_SETTINGS_PUBLISH_LOCK[1]})`);
  const errors = validateSiteSettings(document);
  if (errors.length > 0) return { result: "invalid", errors };

  const live = await readLive(tx);
  const liveRevision = live?.info.revision ?? null;
  if (live && liveRevision !== baseRevision) return { result: "conflict", live: live.info, differing: differingSections(document, live.document) };
  if (!live && baseRevision !== null) throw new Error(`site settings: base revision ${baseRevision} but nothing is live`);

  const revision = (liveRevision ?? 0) + 1;
  const [row] = await tx
    .insert(siteSettingsRevisions)
    .values({ revision, document, publishedById: actor.id, publishedByName: actor.name, note })
    .returning({ publishedAt: siteSettingsRevisions.publishedAt });
  await tx.delete(siteSettingsDrafts).where(eq(siteSettingsDrafts.editorId, actor.id));
  await writeSiteLog(tx, actor, "settings", note ? `Published revision ${revision}: ${note}` : `Published revision ${revision}`);
  await enqueueEvent(
    tx,
    { type: "site.settings.published", source: "nrms", aggregateId: "site:settings", data: { revision, publishedAt: row!.publishedAt.toISOString(), document } },
    subs,
  );
  return { result: "published", revision };
}

/** Saves the draft first (so nothing is lost on invalid or conflict), then publishes it. */
export async function publishSettings(
  db: Db,
  actor: Actor,
  defaults: SiteSettings,
  subs: SubscriberConfig[],
  input: SectionInput & { baseRevision: number | null; note?: string },
): Promise<PublishResult> {
  const { document } = await saveDraft(db, actor, defaults, input);
  const note = input.note?.trim() || null;
  return db.transaction((tx) => publishDocument(tx, actor, subs, document, input.baseRevision, note));
}

export async function discardDraft(db: DbOrTx, actor: Actor): Promise<void> {
  await db.delete(siteSettingsDrafts).where(eq(siteSettingsDrafts.editorId, actor.id));
}

/**
 * "Keep mine on top of theirs": live (or defaults) + this screen's section, based on the live
 * revision. `setAside` = the other sections where the old draft differed from the result.
 */
export async function rebaseDraft(db: Db, actor: Actor, defaults: SiteSettings, input: SectionInput): Promise<SettingsState & { setAside: SectionKey[] }> {
  const setAside = await db.transaction(async (tx) => {
    const [live, draft] = await Promise.all([readLive(tx), readDraft(tx, actor)]);
    const document = overlay(live?.document ?? defaults, input);
    await upsertDraft(tx, actor, document, live?.info.revision ?? null);
    return draft ? differingSections(draft.document, document).filter((k) => k !== input.section) : [];
  });
  return { ...(await getSettingsState(db, actor, defaults)), setAside };
}

/** Every published revision, newest first. */
export async function listHistory(db: DbOrTx): Promise<LiveInfo[]> {
  const rows = await db.select(infoColumns).from(siteSettingsRevisions).orderBy(desc(siteSettingsRevisions.revision));
  return rows.map(toInfo);
}

/** One revision with the sections where it differs from live; null when there's no such revision. */
export async function getRevision(db: DbOrTx, n: number): Promise<{ info: LiveInfo; document: SiteSettings; differing: SectionKey[] } | null> {
  const [row] = await db.select({ ...infoColumns, document: siteSettingsRevisions.document }).from(siteSettingsRevisions).where(eq(siteSettingsRevisions.revision, n));
  if (!row) return null;
  const live = await readLive(db);
  return { info: toInfo(row), document: row.document, differing: live ? differingSections(row.document, live.document) : [] };
}

/**
 * Publishes revision N's document again as a new revision, noted `Restored revision N` and
 * guarded by the base revision the history screen showed; also deletes the restorer's draft.
 * `defaults` is unused today and kept so every write here takes the same arguments.
 */
export async function restoreRevision(
  db: Db,
  actor: Actor,
  _defaults: SiteSettings,
  subs: SubscriberConfig[],
  input: { revision: number; baseRevision: number | null },
): Promise<PublishResult | { result: "not-found" }> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ document: siteSettingsRevisions.document }).from(siteSettingsRevisions).where(eq(siteSettingsRevisions.revision, input.revision));
    if (!row) return { result: "not-found" as const };
    return publishDocument(tx, actor, subs, row.document, input.baseRevision, `Restored revision ${input.revision}`);
  });
}
