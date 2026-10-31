import { desc, eq, sql } from "drizzle-orm";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import { enqueueEvent, type SubscriberConfig } from "@gcpe/events";
import {
  SECTION_LABEL,
  differingSections,
  fillMissingFields,
  siteSettingsSchema,
  validateSiteSettings,
  type FieldError,
  type SectionKey,
  type SiteSettings,
  type StoredSiteSettings,
} from "@gcpe/site-settings";
import { cleanSettingsRichHtml } from "@gcpe/site-settings/rich-html";
import { siteSettingsDrafts, siteSettingsRevisions } from "../db/schema";
import type { Actor } from "../releases/store";
import { writeSiteLog } from "./events";

/**
 * Site settings storage and publishing (site-settings plan, Task 3; spec "Storage and
 * publishing — NRMS"). Published revisions are numbered 1, 2, …; the newest is live. Each editor
 * has at most one draft, remembering the revision it started from — that base revision is the
 * publish concurrency token (it replaces the legacy blob ETag).
 *
 * Revisions and drafts are stored documents (`StoredSiteSettings`): one published before a later
 * part existed (parity plan 4's contactsPage, pageText, navigation, connect.linkedin/policyLink/
 * intro; plan 1's landAcknowledgement) lacks it. Everything that reads one fills it from the
 * tenant defaults (`fillMissingFields`) before showing, validating, comparing or publishing it.
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
  /** Audit #12: the sections where the editor's draft differs from what is live (or, before
   * anything is published, from the defaults), in section order. Empty with no draft. These are
   * what Discard draft throws away and what Publish puts live. */
  draftSections: SectionKey[];
}

export type PublishResult =
  | { result: "published"; revision: number }
  | { result: "invalid"; errors: FieldError[] }
  /** `live` is null when the caller named a base revision but nothing is live (differing is then empty). */
  | { result: "conflict"; live: LiveInfo | null; differing: SectionKey[] };

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

async function readLive(db: DbOrTx): Promise<{ info: LiveInfo; document: StoredSiteSettings } | null> {
  const [row] = await db.select({ ...infoColumns, document: siteSettingsRevisions.document }).from(siteSettingsRevisions).orderBy(desc(siteSettingsRevisions.revision)).limit(1);
  return row ? { info: toInfo(row), document: row.document } : null;
}

async function readDraft(db: DbOrTx, actor: Actor) {
  const [row] = await db.select().from(siteSettingsDrafts).where(eq(siteSettingsDrafts.editorId, actor.id));
  return row ?? null;
}

/** Parses one section's value with its structural schema — always the complete section (a
 * ZodError ⇒ 400) — and overlays it on `doc`; the other parts stay as stored. Every rich HTML
 * field comes out cleaned with the public site's allow-list (P4-R4: what is stored is already
 * safe; an already clean field is kept byte-identical). */
function overlay(doc: StoredSiteSettings, input: SectionInput): StoredSiteSettings {
  const value = siteSettingsSchema.shape[input.section].parse(input.value) as SiteSettings[SectionKey];
  return cleanSettingsRichHtml({ ...doc, [input.section]: value });
}

async function upsertDraft(db: DbOrTx, actor: Actor, document: StoredSiteSettings, baseRevision: number | null): Promise<void> {
  await db
    .insert(siteSettingsDrafts)
    .values({ editorId: actor.id, document, baseRevision })
    .onConflictDoUpdate({ target: siteSettingsDrafts.editorId, set: { document, baseRevision, updatedAt: sql`now()` } });
}

/**
 * The sections where `a` and `b` differ as the site shows them: both filled from the tenant
 * defaults first, so a revision stored before a part existed (no landAcknowledgement, no
 * navigation, …) doesn't report its section as changed against one that carries the default.
 */
const differing = (a: StoredSiteSettings, b: StoredSiteSettings, defaults: SiteSettings): SectionKey[] =>
  differingSections(fillMissingFields(a, defaults), fillMissingFields(b, defaults));

/** What the editor sees: their draft, else live, else the tenant defaults — and its problems. */
export async function getSettingsState(db: DbOrTx, actor: Actor, defaults: SiteSettings): Promise<SettingsState> {
  const live = await readLive(db);
  const draft = await readDraft(db, actor);
  const document = fillMissingFields(draft?.document ?? live?.document ?? defaults, defaults);
  return {
    live: live?.info ?? null,
    document,
    draft: draft ? { baseRevision: draft.baseRevision, updatedAt: draft.updatedAt.toISOString() } : null,
    baseRevision: draft ? draft.baseRevision : (live?.info.revision ?? null),
    errors: validateSiteSettings(document),
    draftSections: draft ? differingSections(document, fillMissingFields(live?.document ?? defaults, defaults)) : [],
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
    // Sequential: one transaction client runs one query at a time.
    const live = await readLive(tx);
    const draft = await readDraft(tx, actor);
    await upsertDraft(tx, actor, overlay(draft?.document ?? live?.document ?? defaults, input), input.baseRevision);
  });
  return getSettingsState(db, actor, defaults);
}

/** The document an editor's draft started from: its base revision, or the defaults when it began before anything was published. */
async function baseDocumentOf(tx: DbOrTx, baseRevision: number | null, defaults: SiteSettings): Promise<StoredSiteSettings> {
  if (baseRevision === null) return defaults;
  const [base] = await tx.select({ document: siteSettingsRevisions.document }).from(siteSettingsRevisions).where(eq(siteSettingsRevisions.revision, baseRevision));
  return base?.document ?? defaults;
}

/**
 * Publishes `document` as revision live+1 under the publish lock: invalid ⇒ nothing written;
 * live ≠ `baseRevision` ⇒ conflict, nothing written; else insert, delete the publisher's draft
 * (other editors keep theirs), log, and enqueue `site.settings.published`.
 *
 * W4 (owner decision 2026-10-31), `onlySection`: what is published is live (or the defaults)
 * with only that section taken from `document`, so a stale or invalid change elsewhere in the
 * draft neither goes live nor blocks it. Fix round 1: a draft based on an older revision only
 * conflicts when someone else changed this same section since that base; other sections they
 * published stay as they are, so nothing of theirs is undone. The revision's note records the
 * partial publish ("Banner only", as Restore records "Restored revision N"). The publisher's
 * draft: based on live, it is re-based on the new revision (deleted when nothing else is left
 * in it); based on an older revision, it is left exactly as it was, so a later full Publish
 * still meets the conflict check.
 */
async function publishDocument(
  tx: Tx,
  actor: Actor,
  defaults: SiteSettings,
  subs: SubscriberConfig[],
  document: SiteSettings,
  baseRevision: number | null,
  note: string | null,
  onlySection?: SectionKey,
): Promise<PublishResult> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${SITE_SETTINGS_PUBLISH_LOCK[0]}, ${SITE_SETTINGS_PUBLISH_LOCK[1]})`);
  const live = await readLive(tx);
  if (onlySection) document = { ...fillMissingFields(live?.document ?? defaults, defaults), [onlySection]: document[onlySection] };
  // Drafts are cleaned on save; this also covers a restored revision stored before cleaning.
  document = cleanSettingsRichHtml(document);
  const errors = validateSiteSettings(document);
  if (errors.length > 0) return { result: "invalid", errors };

  const liveRevision = live?.info.revision ?? null;
  const stale = liveRevision !== baseRevision;
  if (!live && baseRevision !== null) return { result: "conflict", live: null, differing: [] };
  if (live && stale) {
    if (!onlySection) return { result: "conflict", live: live.info, differing: differing(document, live.document, defaults) };
    const theirs = differing(await baseDocumentOf(tx, baseRevision, defaults), live.document, defaults);
    if (theirs.includes(onlySection)) return { result: "conflict", live: live.info, differing: [onlySection] };
  }

  const revision = (liveRevision ?? 0) + 1;
  const storedNote = onlySection ? (note ? `${SECTION_LABEL[onlySection]} only: ${note}` : `${SECTION_LABEL[onlySection]} only`) : note;
  const [row] = await tx
    .insert(siteSettingsRevisions)
    .values({ revision, document, publishedById: actor.id, publishedByName: actor.name, note: storedNote })
    .returning({ publishedAt: siteSettingsRevisions.publishedAt });
  if (!onlySection) {
    await tx.delete(siteSettingsDrafts).where(eq(siteSettingsDrafts.editorId, actor.id));
  } else if (!stale) {
    const draft = await readDraft(tx, actor);
    if (draft && differing(draft.document, document, defaults).length > 0) {
      await tx.update(siteSettingsDrafts).set({ baseRevision: revision, updatedAt: sql`now()` }).where(eq(siteSettingsDrafts.editorId, actor.id));
    } else {
      await tx.delete(siteSettingsDrafts).where(eq(siteSettingsDrafts.editorId, actor.id));
    }
  }
  await writeSiteLog(tx, actor, "settings", storedNote ? `Published revision ${revision}: ${storedNote}` : `Published revision ${revision}`);
  await enqueueEvent(
    tx,
    { type: "site.settings.published", source: "nrms", aggregateId: "site:settings", data: { revision, publishedAt: row!.publishedAt.toISOString(), document } },
    subs,
  );
  return { result: "published", revision };
}

/** Saves the draft first (so nothing is lost on invalid or conflict), then publishes it — the
 * whole draft, or with `onlySection` just this screen's section (W4, see {@link publishDocument}). */
export async function publishSettings(
  db: Db,
  actor: Actor,
  defaults: SiteSettings,
  subs: SubscriberConfig[],
  input: SectionInput & { baseRevision: number | null; note?: string; onlySection?: boolean },
): Promise<PublishResult> {
  const note = input.note?.trim() || null;
  // M2 (fix round 1): the draft is saved in the publish's own transaction, under its lock, so a
  // save from another tab can't land between the two. A refusal still commits the saved draft.
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SITE_SETTINGS_PUBLISH_LOCK[0]}, ${SITE_SETTINGS_PUBLISH_LOCK[1]})`);
    const live = await readLive(tx);
    const draft = await readDraft(tx, actor);
    const saved = overlay(draft?.document ?? live?.document ?? defaults, input);
    await upsertDraft(tx, actor, saved, input.baseRevision);
    return publishDocument(tx, actor, defaults, subs, fillMissingFields(saved, defaults), input.baseRevision, note, input.onlySection ? input.section : undefined);
  });
}

export async function discardDraft(db: DbOrTx, actor: Actor): Promise<void> {
  await db.delete(siteSettingsDrafts).where(eq(siteSettingsDrafts.editorId, actor.id));
}

/**
 * "Keep mine on top of theirs": live (or defaults), with this screen's section and every other
 * section the editor had changed in their old draft (where it differs from the revision it was
 * based on, or the defaults) put back on top, based on the live revision. Fix round 1: nothing
 * of the editor's is thrown away. `alsoChangedByThem` names the other sections kept where the
 * other editor had changed them too, so the editor can check them before publishing; a section
 * only the other editor changed is theirs and stays as they published it.
 */
export async function rebaseDraft(db: Db, actor: Actor, defaults: SiteSettings, input: SectionInput): Promise<SettingsState & { alsoChangedByThem: SectionKey[] }> {
  const alsoChangedByThem = await db.transaction(async (tx) => {
    // Sequential: one transaction client runs one query at a time.
    const live = await readLive(tx);
    const draft = await readDraft(tx, actor);
    const liveDocument = fillMissingFields(live?.document ?? defaults, defaults);
    if (!draft) {
      await upsertDraft(tx, actor, overlay(liveDocument, input), live?.info.revision ?? null);
      return [];
    }
    const baseDocument = await baseDocumentOf(tx, draft.baseRevision, defaults);
    const draftDocument = fillMissingFields(draft.document, defaults);
    const mine = differing(draftDocument, baseDocument, defaults).filter((k) => k !== input.section);
    const theirs = new Set(differing(baseDocument, liveDocument, defaults));
    const kept: StoredSiteSettings = { ...liveDocument };
    for (const k of mine) (kept as Record<SectionKey, unknown>)[k] = draftDocument[k];
    await upsertDraft(tx, actor, overlay(kept, input), live?.info.revision ?? null);
    return mine.filter((k) => theirs.has(k));
  });
  return { ...(await getSettingsState(db, actor, defaults)), alsoChangedByThem };
}

/** Every published revision, newest first. */
export async function listHistory(db: DbOrTx): Promise<LiveInfo[]> {
  const rows = await db.select(infoColumns).from(siteSettingsRevisions).orderBy(desc(siteSettingsRevisions.revision));
  return rows.map(toInfo);
}

/** One revision with the sections where it differs from live; null when there's no such
 * revision. With `defaults`, the document is filled from them and compared filled; without, both
 * are as stored. */
export async function getRevision(
  db: DbOrTx,
  n: number,
  defaults?: SiteSettings,
): Promise<{ info: LiveInfo; document: StoredSiteSettings; differing: SectionKey[] } | null> {
  const [row] = await db.select({ ...infoColumns, document: siteSettingsRevisions.document }).from(siteSettingsRevisions).where(eq(siteSettingsRevisions.revision, n));
  if (!row) return null;
  const live = await readLive(db);
  return {
    info: toInfo(row),
    document: defaults ? fillMissingFields(row.document, defaults) : row.document,
    differing: !live ? [] : defaults ? differing(row.document, live.document, defaults) : differingSections(row.document, live.document),
  };
}

/**
 * Publishes revision N's document again as a new revision, noted `Restored revision N` and
 * guarded by the base revision the history screen showed; also deletes the restorer's draft.
 * A revision from before a later part existed is published filled from `defaults`, so what goes
 * out is complete and validates.
 */
export async function restoreRevision(
  db: Db,
  actor: Actor,
  defaults: SiteSettings,
  subs: SubscriberConfig[],
  input: { revision: number; baseRevision: number | null },
): Promise<PublishResult | { result: "not-found" }> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ document: siteSettingsRevisions.document }).from(siteSettingsRevisions).where(eq(siteSettingsRevisions.revision, input.revision));
    if (!row) return { result: "not-found" as const };
    return publishDocument(tx, actor, defaults, subs, fillMissingFields(row.document, defaults), input.baseRevision, `Restored revision ${input.revision}`);
  });
}
